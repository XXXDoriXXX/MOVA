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
import { CallErrorCode, type InternalCallEvent } from '@mova-back/shared-realtime';

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
/**
 * Lifecycle state machine. Every teardown path consults this to avoid
 * the classic "interlocutor disconnect + user stop arrive within the
 * same tick" double-cleanup race that otherwise double-emits call.ended,
 * double-closes the session, and confuses the mobile post-call sheet.
 *
 * Transitions:
 *   idle → starting (start() called)
 *   starting → active (greeting completed successfully)
 *   starting → ending (start() catch)
 *   active → ending (user stop, room disconnect, fatal mid-call error)
 *   ending → ended (cleanup() ran)
 *
 * Guard contract: stop(), cleanup(), and the RoomEvent.Disconnected
 * handler all short-circuit if state is already 'ending' or 'ended'.
 * The first transition into 'ending' wins — its endedBy / reason are
 * preserved; subsequent triggers are dropped at log level.
 */
type CallState = 'idle' | 'starting' | 'active' | 'ending' | 'ended';

/**
 * `say()` wrapper outcome. We need a tri-state instead of a plain
 * Promise so callers (greeting / idle probe / silence fallback) can each
 * apply their own policy — greeting failure is fatal, probe failure is
 * "retry without bumping the counter", fallback failure is "give up".
 */
type SaySafeResult =
  | { ok: true; reason: null; error: null }
  | { ok: false; reason: 'timeout' | 'error'; error: Error };

export class AgentCallHandler {
  private readonly logger: Logger;
  private room: Room | null = null;
  private session: voice.AgentSession | null = null;

  /** See `CallState` doc above. Mutated through `transitionTo()` only. */
  private state: CallState = 'idle';
  /** First-wins record of why we entered `ending`. Subsequent teardown
   *  signals are logged but do NOT override these — duplicate
   *  RoomEvent.Disconnected after we already called stop() must not
   *  rewrite the user-initiated reason as "interlocutor". */
  private endedBy: 'user' | 'interlocutor' | 'system' | 'admin' | null = null;
  private endReason:
    | 'user'
    | 'interlocutor'
    | 'balance'
    | 'fatal_error'
    | 'timeout'
    | 'admin'
    | null = null;
  private endErrorCode: string | null = null;

  /** TTS hard timeout. If `session.say()` doesn't resolve within this
   *  window we treat TTS as broken — the underlying audio pipeline can
   *  fail without the SDK ever emitting an `error` event (stream chunk
   *  timeout, provider socket hang). Per-call greeting gets a longer
   *  budget because cold-start of an ElevenLabs/Google TTS session
   *  legitimately takes 2-4s on first byte. */
  private static readonly TTS_SAY_TIMEOUT_MS = 8_000;
  private static readonly TTS_GREETING_TIMEOUT_MS = 12_000;

  /** deleteRoom retry policy. LiveKit control-plane blips are common in
   *  dev; in prod a single 503 from the control-plane would otherwise
   *  leave the SIP leg ringing on the trunk side until the room idles
   *  out (~5 min default). Three retries with exponential backoff cover
   *  the vast majority of transient failures. */
  private static readonly DELETE_ROOM_RETRIES = 3;
  private static readonly DELETE_ROOM_BACKOFF_MS = [200, 800, 2_400];

  /** STT-stall watchdog. The SIP participant is on the line (we know —
   *  `participantAnswered` is true) but Deepgram/etc. hasn't emitted
   *  ANY transcript activity (partial or final) in this many ms. This
   *  catches the silent-failure mode where the STT websocket dies and
   *  no error surfaces — the agent quietly goes deaf and the user gets
   *  ghosted. We emit STT_STALLED so mobile can show "перевірте звʼязок"
   *  and (optionally) hand back to typed input. */
  private sttStallTimer: NodeJS.Timeout | null = null;
  private static readonly STT_STALL_TIMEOUT_MS = 30_000;
  /** True after we've emitted STT_STALLED at least once in this call,
   *  so we don't spam the banner if STT keeps stalling and recovering. */
  private sttStalledEmitted = false;

  /** Consecutive heartbeat publish failures. Beyond 3 we log at error
   *  level (not debug) because at that point realtime-service has
   *  almost certainly declared AGENT_LOST on the mobile side already
   *  and the user is staring at a frozen call screen. */
  private heartbeatFailures = 0;
  private static readonly HEARTBEAT_FAIL_ALARM = 3;

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
    if (this.state !== 'idle') {
      this.logger.warn(`start() ignored — state=${this.state} (not idle)`);
      return;
    }
    this.state = 'starting';
    const callStartTime = Date.now();
    this.callStartTime = callStartTime;
    this.logger.log(`📞 [Call Lifecycle] Initiating connection sequence...`);

    // Track which step failed so the catch can pick a specific errorCode
    // instead of always reporting AGENT_LOST. Mobile maps the code to a
    // localized message + recovery action — a generic catch hides whether
    // the problem is "phone-network unreachable" (user can retry now) or
    // "TTS provider down" (user should wait / switch voice).
    let phase:
      | 'config'
      | 'token'
      | 'room_connect'
      | 'session_init'
      | 'greeting'
      | 'done' = 'config';

    try {
      const apiKey = this.config.getOrThrow<string>('LIVEKIT_API_KEY');
      const apiSecret = this.config.getOrThrow<string>('LIVEKIT_API_SECRET');
      const wsURL = this.config.getOrThrow<string>('LIVEKIT_URL');

      phase = 'token';
      const at = new AccessToken(apiKey, apiSecret, {
        identity: `agent-${this.roomName}`,
        name: this.userContext.userName,
      });
      at.addGrant({ roomJoin: true, room: this.roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();

      phase = 'room_connect';
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
        // If we already started tearing down (user pressed end_call,
        // start() failed, fatal mid-call error), the call.ended event
        // for the real cause was already emitted. The LiveKit SDK will
        // fire Disconnected as part of OUR own room.disconnect() —
        // re-emitting here would overwrite the user-initiated reason
        // with "interlocutor". Idempotent: only the first reason wins.
        if (this.state === 'ending' || this.state === 'ended') {
          this.logger.debug(
            `RoomEvent.Disconnected ignored — already ${this.state}.`,
          );
          return;
        }
        const durationMs = Date.now() - callStartTime;
        this.logger.log(`🚪 [Call Lifecycle] Room disconnected after ${durationMs}ms.`);
        // Reason is best-effort — distinguishing interlocutor-hangup from
        // network drop needs SIP-event introspection (Phase 8 work).
        this.beginEnd('interlocutor', 'interlocutor');
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

      phase = 'session_init';
      const sessionResult = await this.agentFactory.createSession(
        this.vadModel,
        this.userContext,
      );
      this.session = sessionResult.session;
      // Surface a degradation banner from the very first turn when the
      // user's preferred LLM was unhealthy and the registry routed us to
      // a fallback. Mobile shows the existing recoverable provider.failure
      // banner — no silent substitution.
      if (sessionResult.llmProvenance.viaFallback) {
        this.logger.warn(
          `[Provider] LLM requested=${sessionResult.llmProvenance.requestedProvider} ` +
            `unhealthy → using ${sessionResult.llmProvenance.effectiveProvider} instead.`,
        );
        this.emitTyped({
          type: 'provider.failure',
          data: {
            providerType: 'llm',
            providerName: sessionResult.llmProvenance.requestedProvider,
            errorCode: 'PROVIDER_DEGRADED',
            errorMessage: `Requested ${sessionResult.llmProvenance.requestedProvider} is degraded — using ${sessionResult.llmProvenance.effectiveProvider}.`,
          },
        });
      }
      // Broadcast the active call config so the mobile UI can show
      // "now using GPT-4o + ElevenLabs (Rachel)" at-a-glance. Emitted as
      // three separate \`call.config.changed\` events because the existing
      // event shape carries one providerType at a time; mobile's reducer
      // updates the right slot per event. styleId rides on the LLM event
      // (the agent-context already resolved it; the suggestion service
      // will read the same value on its first turn).
      this.emitTyped({
        type: 'call.config.changed',
        data: {
          providerType: 'llm',
          provider: sessionResult.llmProvenance.effectiveProvider,
          model: sessionResult.llmProvenance.effectiveModel ?? undefined,
          styleId: this.userContext.activeStyleId,
        },
      });
      this.emitTyped({
        type: 'call.config.changed',
        data: {
          providerType: 'stt',
          provider: sessionResult.sttProvenance.provider,
          model: sessionResult.sttProvenance.model,
        },
      });
      this.emitTyped({
        type: 'call.config.changed',
        data: {
          providerType: 'tts',
          provider: sessionResult.ttsProvenance.provider,
          voice: sessionResult.ttsProvenance.voice,
        },
      });
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
      //
      // The greeting doubles as a TTS preflight: if it fails or hangs,
      // we know the audio pipeline is broken before the SIP leg starts
      // wasting balance on silent air. Failure here is FATAL
      // (TTS_UNAVAILABLE) — without TTS there is literally no call.
      phase = 'greeting';
      const greetingResult = await this.safeSay(
        this.agentFactory.getInitialGreeting(this.userContext),
        AgentCallHandler.TTS_GREETING_TIMEOUT_MS,
        { allowInterruptions: true },
      );
      if (!greetingResult.ok) {
        throw new Error(
          `Greeting TTS ${greetingResult.reason}: ` +
            (greetingResult.error?.message ?? 'no error detail'),
        );
      }
      // Greeting done — promote to active. Start the idle-probe timer
      // so a non-responsive interlocutor doesn't strand the call in
      // silence, and arm the STT-stall watchdog now that SIP audio is
      // expected to be flowing.
      this.state = 'active';
      this.armIdleProbe();
      this.armSttStall();

      this.logger.log(
        `🎉 [Call Lifecycle] Connection sequence completed in ${Date.now() - callStartTime}ms`,
      );
      phase = 'done';
    } catch (error) {
      const err = error as Error;
      // Map the failed phase to a specific CallErrorCode. Mobile picks
      // the right banner / modal copy from the code; "fatal_error" alone
      // would render generic "internal error" everywhere.
      const errorCode: string = (() => {
        switch (phase) {
          case 'config':
          case 'token':
            return CallErrorCode.FATAL_INTERNAL;
          case 'room_connect':
            return CallErrorCode.LIVEKIT_DISCONNECTED;
          case 'session_init':
            // Most likely: STT/LLM/TTS plugin init failed (bad API key,
            // provider down). LLM_UNAVAILABLE is the most actionable
            // generic — user can swap providers and retry.
            return CallErrorCode.LLM_UNAVAILABLE;
          case 'greeting':
            return CallErrorCode.TTS_UNAVAILABLE;
          default:
            return CallErrorCode.AGENT_LOST;
        }
      })();
      this.logger.error(
        `❌ [Call Lifecycle] Fatal error during call setup (phase=${phase}, code=${errorCode}): ${err.message}`,
        err.stack,
      );
      this.beginEnd('system', 'fatal_error', errorCode);
      this.emitTyped({
        type: 'call.ended',
        data: {
          endedBy: 'system',
          reason: 'fatal_error',
          errorCode,
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
    if (this.state === 'ending' || this.state === 'ended') {
      this.logger.debug(
        `🛑 [Agent Control] interruptAndSpeak ignored — call is ${this.state}.`,
      );
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
    // Same rule as for the greeting: this MUST be interruptible. A
    // non-interruptible say() pins `_currentSpeech` and starves every
    // future LLM turn ("skipping user input" warn). User-typed lines
    // are short anyway; if the user types a second one in quick
    // succession, interrupting the first is the right behavior.
    const result = await this.safeSay(
      text,
      AgentCallHandler.TTS_SAY_TIMEOUT_MS,
      { allowInterruptions: true, addToChatCtx: true },
    );
    if (result.ok) {
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
    } else {
      // The user typed a line and we couldn't speak it. Don't end the
      // call — typed input is the secondary channel; let them keep
      // trying with text. Surface as a recoverable TTS_DEGRADED banner
      // so the UI can show "couldn't speak that — try again".
      reportError(this.logger, '[Agent Control] safeSay failed for user text', result.error, {
        conversationId: this.conversationId,
        textLength: text.length,
        reason: result.reason,
      });
      this.emitTyped({
        type: 'provider.failure',
        data: {
          providerType: 'tts',
          providerName: this.userContext.config?.tts?.provider ?? 'unknown',
          errorCode: CallErrorCode.TTS_DEGRADED,
          errorMessage: `Could not speak typed message (${result.reason}).`,
        },
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
    if (this.state === 'ending' || this.state === 'ended') {
      this.logger.debug(`setActiveStyle ignored — call is ${this.state}.`);
      return;
    }
    this.userContext.activeStyleId = styleId;
    this.logger.log(`[Style] active style → ${styleId}`);
    this.emitTyped({
      type: 'call.config.changed',
      data: { styleId },
    });
  }

  /** Forced end of the call from the user side. */
  async stop(): Promise<void> {
    // State guard: stop() is called from at least three places (mobile
    // end_call control, idle-probe exhaustion, OnApplicationShutdown
    // drain). Two of them firing within the same tick used to double-
    // emit call.ended and double-run deleteRoom. The guard makes stop()
    // safely idempotent.
    if (this.state === 'ending' || this.state === 'ended') {
      this.logger.debug(`stop() ignored — already ${this.state}.`);
      return;
    }
    const durationMs = this.callStartTime ? Date.now() - this.callStartTime : 0;
    this.beginEnd('user', 'user');
    this.emitTyped({
      type: 'call.ended',
      data: { endedBy: 'user', reason: 'user', durationMs },
    });
    // `room.disconnect()` alone only drops the agent — the SIP participant
    // (the phone) stays in the room and the real call keeps ringing/talking.
    // Deleting the room kicks every participant, which terminates the SIP
    // leg on the trunk side. We retry on transient LiveKit control-plane
    // failures with exponential backoff so a single 503 doesn't leave the
    // caller's phone ringing for 5 minutes (default room idle timeout).
    await this.deleteRoomWithRetry();
    this.cleanup();
  }

  /**
   * Three-attempt deleteRoom with exponential backoff. Why a custom
   * loop instead of a generic retry utility:
   *
   *   - We only want to retry on network / 5xx; a 404 ("room already
   *     gone") is success.
   *   - We don't want to hold up cleanup() longer than ~3.5s total —
   *     the user already pressed hang-up; their UI is waiting.
   *   - On total failure we MUST still proceed to cleanup() so we don't
   *     leak the local AgentSession / room handle. The orphan-SIP risk
   *     is then handed off to the LiveKit room idle timeout — not ideal,
   *     but better than blocking forever.
   */
  private async deleteRoomWithRetry(): Promise<void> {
    const wssUrl = this.config.get<string>('LIVEKIT_URL');
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET');
    if (!wssUrl || !apiKey || !apiSecret) {
      this.logger.warn(
        `deleteRoom skipped — LIVEKIT_URL/KEY/SECRET not configured.`,
      );
      return;
    }
    const httpUrl = wssUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret);

    for (let attempt = 0; attempt < AgentCallHandler.DELETE_ROOM_RETRIES; attempt++) {
      try {
        await roomService.deleteRoom(this.roomName);
        this.logger.log(
          `📞 [Call Lifecycle] LiveKit room deleted (attempt ${attempt + 1}) — SIP leg hung up`,
        );
        return;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        // 404 / "not found" / "room does not exist" — already gone, that's success.
        if (/not.?found|does not exist|404/i.test(message)) {
          this.logger.debug(`deleteRoom: room already gone (${message})`);
          return;
        }
        const last = attempt === AgentCallHandler.DELETE_ROOM_RETRIES - 1;
        this.logger.warn(
          `deleteRoom attempt ${attempt + 1}/${AgentCallHandler.DELETE_ROOM_RETRIES} failed: ${message}${last ? ' — giving up; SIP may linger until LiveKit idle timeout' : ''}`,
        );
        if (last) return;
        await new Promise((resolve) =>
          setTimeout(resolve, AgentCallHandler.DELETE_ROOM_BACKOFF_MS[attempt] ?? 1000),
        );
      }
    }
  }

  // ─── internals ─────────────────────────────────────

  private cleanup(): void {
    if (this.state === 'ended') {
      // Already cleaned up — happens when stop() and RoomEvent.Disconnected
      // both fire (e.g. mobile end_call → room.disconnect → SDK re-emits
      // Disconnected). Returning is safe because all underlying handles
      // are already null.
      this.logger.debug('cleanup() ignored — already ended.');
      return;
    }
    // Don't downgrade an explicit ending → no-op; just promote to ended.
    if (this.state !== 'ending') this.state = 'ending';
    this.stopHeartbeat();
    this.clearResponseWatchdog();
    this.clearIdleProbe();
    this.clearSttStall();
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
    this.state = 'ended';
    this.onDisconnectCb(this.roomName);
  }

  /**
   * Record the first-wins reason a call ended. Idempotent: if endedBy
   * is already set we keep the prior values (the first signal — user
   * stop, fatal error in start(), interlocutor disconnect — represents
   * the actual cause; later ones are just downstream consequences).
   * Also moves state to 'ending' so concurrent guards short-circuit.
   */
  private beginEnd(
    endedBy: 'user' | 'interlocutor' | 'system' | 'admin',
    reason: 'user' | 'interlocutor' | 'balance' | 'fatal_error' | 'timeout' | 'admin',
    errorCode?: string,
  ): void {
    if (this.endedBy === null) {
      this.endedBy = endedBy;
      this.endReason = reason;
      this.endErrorCode = errorCode ?? null;
    }
    if (this.state !== 'ending' && this.state !== 'ended') {
      this.state = 'ending';
    }
  }

  private bindSessionEvents(session: voice.AgentSession): void {
    const sessionEmitter = session as unknown as EventEmitter;

    sessionEmitter.on('user_input_transcribed', (ev: Record<string, unknown>) => {
      const text = (ev['text'] as string) ?? (ev['transcript'] as string) ?? '';
      if (!text) return;

      // Any sound from the interlocutor — partial or final — proves
      // they're alive AND that STT is delivering transcripts. Stand the
      // idle-probe down, reset its count, and re-arm the STT-stall
      // watchdog (which counts time since the LAST transcript activity).
      this.clearIdleProbe();
      this.idleProbeCount = 0;
      this.armSttStall();
      // STT recovered after a stall — let the UI clear the banner on
      // the next provider.failure of a different type. The flag stays
      // true so we don't re-emit STT_STALLED for every recovery cycle.

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
      // If we're already tearing down, every "session closed" / "stream
      // aborted" error is downstream noise — propagating them to mobile
      // as provider.failure would show a confusing banner just before
      // the call.ended modal pops up.
      if (this.state === 'ending' || this.state === 'ended') return;
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
      // Map providerType to the canonical CallErrorCode so mobile shows
      // the right localized message instead of a raw exception name.
      // Recoverable codes — the call continues with a degradation banner;
      // the watchdog / idle probe / safeSay timeouts handle real fatal
      // failures separately (those become FATAL_INTERNAL / TTS_UNAVAILABLE).
      const errorCode: string = (() => {
        switch (providerType) {
          case 'tts':
            return CallErrorCode.TTS_DEGRADED;
          case 'stt':
            return CallErrorCode.STT_DEGRADED;
          case 'llm':
            return CallErrorCode.LLM_DEGRADED;
        }
      })();
      // Surface to the mobile client as a recoverable degradation banner.
      this.emitTyped({
        type: 'provider.failure',
        data: {
          providerType,
          providerName: source || 'unknown',
          errorCode,
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
    if (this.state !== 'active') return;
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
    this.logger.log(
      `[Idle probe] No interlocutor input — probing (${this.idleProbeCount + 1}/${AgentCallHandler.IDLE_MAX_PROBES}): "${line}"`,
    );
    const result = await this.safeSay(
      line,
      AgentCallHandler.TTS_SAY_TIMEOUT_MS,
      { allowInterruptions: true },
    );
    if (result.ok) {
      // Probe was actually spoken — count it and emit transcript.
      this.idleProbeCount += 1;
      this.recordRecent('ai', line);
      this.emitTyped({
        type: 'ai.text.final',
        data: { text: line, llmProvider: 'idle_probe', llmModel: 'static' },
      });
      // Re-arm with the longer follow-up window so we don't pester.
      this.armIdleProbe();
    } else {
      // TTS broke for this probe. DON'T bump idleProbeCount — otherwise
      // three TTS failures in a row end the call as "user didn't reply"
      // when actually the user heard nothing. Re-arm a shorter retry
      // window; if TTS stays broken the safeSay timeout for the GREETING
      // path would have caught it. Here we just keep trying.
      reportError(this.logger, '[Idle probe] safeSay failed — will retry', result.error, {
        conversationId: this.conversationId,
        reason: result.reason,
      });
      this.armIdleProbe();
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
    if (this.state !== 'active') return;
    const lines = AgentCallHandler.FALLBACK_LINES_UA;
    const line = lines[this.fallbackCursor % lines.length]!;
    this.fallbackCursor += 1;
    this.logger.warn(
      `[AI fallback] AI silent (reason=${reason}); speaking: "${line}"`,
    );
    const result = await this.safeSay(
      line,
      AgentCallHandler.TTS_SAY_TIMEOUT_MS,
      { allowInterruptions: true },
    );
    if (result.ok) {
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
    } else {
      // The fallback itself failed to speak. This is the worst case:
      // the LLM didn't reply AND TTS is now broken. Continuing means
      // dead air both ways. End the call with TTS_UNAVAILABLE so mobile
      // shows the right modal instead of a frozen call screen.
      reportError(this.logger, '[AI fallback] safeSay failed — ending call', result.error, {
        conversationId: this.conversationId,
        reason,
        sayResult: result.reason,
      });
      const durationMs = this.callStartTime ? Date.now() - this.callStartTime : 0;
      this.beginEnd('system', 'fatal_error', CallErrorCode.TTS_UNAVAILABLE);
      this.emitTyped({
        type: 'call.ended',
        data: {
          endedBy: 'system',
          reason: 'fatal_error',
          errorCode: CallErrorCode.TTS_UNAVAILABLE,
          durationMs,
        },
      });
      this.cleanup();
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
   * Promise.race wrapper around `session.say()`. The bare SDK promise
   * can hang silently when a TTS provider stream drops mid-chunk —
   * neither resolving nor emitting the session.error event we listen to
   * in bindSessionEvents. Without this timeout the entire call freezes:
   * idle probe can't fire (no AI turn boundary), watchdog can't fire
   * (we never armed the response watchdog for an internal say), the
   * caller hears dead air, and nothing tells the user why.
   *
   * Returns a structured result rather than throwing so each call site
   * (greeting / probe / fallback / user-typed) can apply its own
   * policy without try/catch boilerplate.
   *
   * Note: we cannot CANCEL the underlying say() on timeout — the SDK
   * has no abort API on the SpeechHandle. The dangling promise is
   * caught with a .catch to keep it from becoming an unhandled
   * rejection. If TTS recovers later, the audio plays orphaned
   * (the SDK still pushes the audio frames); this is acceptable
   * because we've already moved on (probe retry, call ended, etc.).
   */
  private async safeSay(
    text: string,
    timeoutMs: number,
    opts: { allowInterruptions: boolean; addToChatCtx?: boolean },
  ): Promise<SaySafeResult> {
    if (!this.session) {
      return { ok: false, reason: 'error', error: new Error('session is null') };
    }
    const session = this.session;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<SaySafeResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          reason: 'timeout',
          error: new Error(`TTS say() did not resolve within ${timeoutMs}ms`),
        });
      }, timeoutMs);
    });
    // Wrap session.say so the .catch() can't surface as unhandled if
    // the SDK rejects AFTER our timeout already resolved the race.
    const sayPromise: Promise<SaySafeResult> = (async (): Promise<SaySafeResult> => {
      try {
        await session.say(text, opts);
        return { ok: true, reason: null, error: null };
      } catch (error) {
        return {
          ok: false,
          reason: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    })();
    sayPromise.catch(() => {
      /* swallowed — already handled inside the IIFE above */
    });
    const result = await Promise.race([sayPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    return result;
  }

  // ─── STT stall watchdog (silent transcription failure) ───
  //
  // We can't tell whether the SIP audio is actually arriving at the
  // STT plugin from inside our process — the LiveKit Agents SDK
  // doesn't expose VAD-level frame counters. Instead we time the gap
  // between transcript events (partial OR final). After
  // STT_STALL_TIMEOUT_MS without any transcript activity — but with
  // the SIP participant joined — we assume STT silently died and
  // surface STT_STALLED. The call keeps going (the user can switch
  // to typed input; the AI agent can still talk OUT) but mobile
  // shows the warning banner.

  private armSttStall(): void {
    this.clearSttStall();
    if (!this.participantAnswered) return;
    if (this.state !== 'active' && this.state !== 'starting') return;
    this.sttStallTimer = setTimeout(() => {
      this.fireSttStall();
    }, AgentCallHandler.STT_STALL_TIMEOUT_MS);
  }

  private clearSttStall(): void {
    if (this.sttStallTimer) {
      clearTimeout(this.sttStallTimer);
      this.sttStallTimer = null;
    }
  }

  private fireSttStall(): void {
    this.sttStallTimer = null;
    if (this.state !== 'active') return;
    if (this.sttStalledEmitted) return;
    this.sttStalledEmitted = true;
    this.logger.warn(
      `[STT stall] No transcript activity for ${AgentCallHandler.STT_STALL_TIMEOUT_MS}ms — emitting STT_STALLED.`,
    );
    this.emitTyped({
      type: 'provider.failure',
      data: {
        providerType: 'stt',
        providerName: this.userContext.config?.stt?.provider ?? 'unknown',
        errorCode: CallErrorCode.STT_STALLED,
        errorMessage: 'STT delivered no transcripts for 30s.',
      },
    });
    // Re-arm: if STT recovers we'll get user_input_transcribed and reset
    // sttStalledEmitted is intentionally NOT reset — we don't want to
    // flap the banner every 30s if the connection is genuinely flaky.
    this.armSttStall();
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
        .then(() => {
          // Reset counter on any successful publish so transient blips
          // don't accumulate forever and trigger a false alarm later.
          this.heartbeatFailures = 0;
        })
        .catch((err: Error) => {
          this.heartbeatFailures += 1;
          // Below alarm threshold this is just noise (single blip → next
          // tick recovers). At/above threshold mobile has almost
          // certainly seen AGENT_LOST on its side; we need the loud log
          // so ops can correlate the user's complaint with our trace.
          if (this.heartbeatFailures >= AgentCallHandler.HEARTBEAT_FAIL_ALARM) {
            this.logger.error(
              `Heartbeat publish failed ${this.heartbeatFailures}× in a row — realtime-service likely sees AGENT_LOST. Last error: ${err.message}`,
            );
          } else {
            this.logger.debug(`Heartbeat publish failed: ${err.message}`);
          }
        });
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
