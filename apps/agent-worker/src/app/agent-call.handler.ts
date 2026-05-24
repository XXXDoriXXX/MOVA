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
import { LlmProviderEnum } from '@mova-back/shared-agent';

import { AgentFactory, AgentContext } from './agent/agent.factory';
import { CallEventPublisher } from './events/call-event.publisher';
import { StyleResolverService } from './suggestions/style-resolver.service';
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

  /**
   * Hard call-duration deadline. Armed in start() once we have an
   * actual session. Fires CallErrorCode.CALL_TIMEOUT and tears down via
   * the standard stop() path so the post-call sheet and billing both
   * see a clean end. Without this, a crashed/leaked SIP participant
   * keeps the LiveKit room alive (~5 min idle timeout) and bills the
   * user / our telco trunk for the whole window.
   *
   * Default cap is enforced by billing eligibility per plan
   * (`maxCallDurationSeconds`), passed through agentContext. Free-tier
   * users get a tight cap (e.g. 5 min), paid plans a generous one
   * (e.g. 60 min) — both are upper bounds, not nominal call lengths.
   */
  private callDeadlineTimer: NodeJS.Timeout | null = null;
  /** Fallback when context has no maxCallDurationSeconds (legacy call
   *  context, mis-configured plan, etc.). 1 hour ceiling — high enough
   *  to never trip a real conversation, low enough to bound runaway
   *  spend at one user-hour of telco/LLM cost. */
  private static readonly DEFAULT_CALL_DEADLINE_MS = 60 * 60 * 1000;

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

  /** Polite "I'm thinking" lines we speak when reply generation yields
   *  nothing usable. Kept short and intentionally non-meta (never says
   *  "I'm an AI"). */
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

  /**
   * Per-call "preview before speak" controls. When ON (default), the
   * LLM's reply for each interlocutor turn pauses briefly as a
   * candidate that the user can see, accept, or cancel before TTS
   * plays. The auto-accept timer fires after AUTO_ACCEPT_DELAY_MS so
   * normal flow still feels conversational. When OFF, every reply
   * waits for an explicit accept WS command from mobile.
   *
   * Per-call (not per-user) on purpose: a sensitive call to a doctor
   * warrants tighter control than a delivery dispatch; the toggle
   * lives on the in-call drawer.
   */
  private autoMode = true;
  private static readonly AUTO_ACCEPT_DELAY_MS = 5_000;
  /** Manual mode has a long-tail safety timeout so a stuck mobile
   *  client (lost the candidate event, never accepted) doesn't leak
   *  the pending Promise forever. 60s is long enough for any human
   *  decision; past that we fail closed (cancel). */
  private static readonly MANUAL_TIMEOUT_MS = 60_000;

  /**
   * The single in-flight AI candidate awaiting a user decision. Only
   * ever one at a time. Speech is NOT gated through a Promise anymore —
   * resolveCandidate(accept) calls session.say() directly. The timer
   * is the auto-accept (auto mode) or safety-cancel (manual mode).
   */
  private currentCandidate: {
    id: string;
    text: string;
    timer: NodeJS.Timeout | null;
    /** False while the reply is still streaming in; true once generation
     *  completes. The auto-accept/safety timer is only armed after this. */
    finalized: boolean;
    /** Set if the user hit accept while the text was still streaming —
     *  we speak the full text the moment generation finalizes. */
    acceptedEarly: boolean;
  } | null = null;

  /** Aborts the in-flight streaming generation (cancel / supersede). */
  private candidateAbort: AbortController | null = null;

  constructor(
    private readonly roomName: string,
    public readonly userContext: AgentContext,
    private readonly config: ConfigService,
    private readonly agentFactory: AgentFactory,
    private readonly vadModel: silero.VAD,
    private readonly redis: Redis,
    private readonly publisher: CallEventPublisher,
    private readonly suggestions: SuggestionsService,
    private readonly styleResolver: StyleResolverService,
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

      // Resolve the conversation style into the prompt block BEFORE the
      // session is created — AgentFactory.createAgent reads it from
      // userContext.styleInstructions when assembling the system prompt
      // so the user's chosen tone (OFFICIAL / FRIENDLY / PERSONAL /
      // custom) shapes the actual agent voice, not just suggestions.
      // resolveStyle never throws — on any failure it returns null and
      // the prompt falls back to neutral.
      try {
        this.userContext.styleInstructions = await this.styleResolver.resolve(
          this.userContext.userId ?? null,
          this.userContext.activeStyleId,
        );
      } catch (err) {
        // Style resolution is decorative — a failure must NEVER block
        // the call. Worst case: neutral tone. Log + continue.
        reportError(this.logger, '[Style] resolve failed (continuing with neutral tone)', err, {
          conversationId: this.conversationId,
          styleId: this.userContext.activeStyleId,
        });
        this.userContext.styleInstructions = null;
      }

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
      // Plain agent — the session has no llm (see AgentFactory), so the
      // framework does STT only and never auto-replies. We generate each
      // reply ourselves in onInterlocutorFinal and speak it via
      // session.say() on candidate-accept. No ttsNode gating needed.
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
      const greetingText = this.agentFactory.getInitialGreeting(this.userContext);
      const greetingResult = await this.safeSay(
        greetingText,
        AgentCallHandler.TTS_GREETING_TIMEOUT_MS,
        { allowInterruptions: true },
      );
      if (!greetingResult.ok) {
        throw new Error(
          `Greeting TTS ${greetingResult.reason}: ` +
            (greetingResult.error?.message ?? 'no error detail'),
        );
      }
      // Surface the greeting as a chat bubble. conversation_item_added
      // no longer emits (it raced the candidate gate), so direct say()s
      // publish their own ai.text.final. The greeting is the AI's
      // opening line — the user should see it land in chat as the call
      // goes live.
      this.emitTyped({
        type: 'ai.text.final',
        data: { text: greetingText, llmProvider: 'greeting', llmModel: 'static' },
      });
      // Greeting done — promote to active. Start the idle-probe timer
      // so a non-responsive interlocutor doesn't strand the call in
      // silence, arm the STT-stall watchdog now that SIP audio is
      // expected to be flowing, and arm the hard call-duration deadline
      // so a leaked / crashed session can't run indefinitely.
      this.state = 'active';
      this.armIdleProbe();
      this.armSttStall();
      this.armCallDeadline();

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
    this.clearIdleProbe();
    this.clearSttStall();
    this.clearCallDeadline();
    this.clearCandidate();
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

    // NOTE: conversation_item_added is intentionally NOT used to emit
    // chat events. The session has no LLM, so it never auto-generates a
    // reply — we own the whole reply lifecycle: onInterlocutorFinal →
    // generateAndPresentReply (preview) → resolveCandidate(accept) →
    // onAiFinal emits ai.text.final + session.say() speaks it. Direct
    // say()s (greeting / fallback / idle-probe) emit their own
    // ai.text.final explicitly; user-typed emits user.spoke. A listener
    // here would double-publish, so it's removed entirely.

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
    });
  }

  // ─── AI candidate gate (preview-before-speak) ──────────

  /**
   * Public toggle for the mobile drawer's auto-mode switch.
   * - true  → candidates auto-accept after AUTO_ACCEPT_DELAY_MS
   * - false → candidates wait for explicit user.accept_ai_reply
   *
   * If a candidate is currently pending we adjust ITS timer too: a
   * mid-flight flip from auto→manual cancels the auto-accept; a flip
   * from manual→auto starts one. This way the toggle "feels live".
   */
  setAutoMode(enabled: boolean): void {
    if (this.autoMode === enabled) return;
    this.autoMode = enabled;
    const candidate = this.currentCandidate;
    // Only a FINALIZED candidate has (or needs) an auto-accept timer. A
    // still-streaming one picks up the new mode when it finalizes.
    if (!candidate || !candidate.finalized) {
      this.logger.log(`[Candidate] auto-mode → ${enabled ? 'ON' : 'OFF'}`);
      return;
    }
    if (candidate.timer) {
      clearTimeout(candidate.timer);
      candidate.timer = null;
    }
    if (enabled) {
      candidate.timer = setTimeout(
        () => this.resolveCandidate(candidate.id, true),
        AgentCallHandler.AUTO_ACCEPT_DELAY_MS,
      );
    }
    // Re-emit so mobile flips the card between countdown ring and manual
    // mic affordance live.
    this.emitCandidate(candidate.id, candidate.text, false);
    this.logger.log(`[Candidate] auto-mode → ${enabled ? 'ON' : 'OFF'}`);
  }

  /** Public — called from the WS control handler. Idempotent on a
   *  stale candidateId (different turn already resolved) so a delayed
   *  network packet can't double-promote. */
  acceptAiReply(candidateId: string): void {
    this.resolveCandidate(candidateId, true);
  }

  cancelAiReply(candidateId: string): void {
    this.resolveCandidate(candidateId, false);
  }

  /**
   * Generate the main reply for an interlocutor turn and present it as
   * a candidate. Called (fire-and-forget) from onInterlocutorFinal.
   * The session has no LLM, so nothing auto-speaks — we own the whole
   * reply lifecycle: generate → preview → (accept) speak.
   *
   * On generation failure we DON'T silently drop — the AI-silence
   * fallback covers it (handleAiSilence speaks "can you repeat?") so
   * the line never goes mute.
   */
  private async generateAndPresentReply(parentText: string): Promise<void> {
    if (!this.conversationId || !this.userContext.template) return;
    // A newer interlocutor turn supersedes any in-flight candidate:
    // abort its generation and drop it (mobile replaces the card on the
    // new candidate event).
    this.clearCandidate();

    // Surface a "thinking" indicator until the first token lands.
    this.emitTyped({ type: 'ai.thinking', data: {} });

    const preferProvider = this.userContext.config?.llm?.provider as
      | LlmProviderEnum
      | undefined;

    const id = randomUUID();
    const abort = new AbortController();
    this.candidateAbort = abort;
    this.currentCandidate = {
      id,
      text: '',
      timer: null,
      finalized: false,
      acceptedEarly: false,
    };
    // Initial streaming card — empty text, no countdown yet.
    this.emitCandidate(id, '', true);

    let lastEmit = 0;
    const reply = await this.suggestions.generateReplyStream(
      {
        conversationId: this.conversationId,
        parentMessageId: randomUUID(),
        parentMessageText: parentText,
        systemPrompt: this.userContext.template.systemPrompt,
        recentMessages: this.recentMessages.slice(),
        language: this.userContext.template.language,
        userId: this.userContext.userId,
        styleId: this.userContext.activeStyleId,
      },
      (cumulative) => {
        // Drop chunks for a candidate that was cancelled / superseded.
        if (this.currentCandidate?.id !== id) return;
        this.currentCandidate.text = cumulative;
        // Throttle WS chatter — emit at most ~8/s; the finalize emit below
        // always lands the complete text.
        const now = Date.now();
        if (now - lastEmit < 120) return;
        lastEmit = now;
        this.emitCandidate(id, cumulative, true);
      },
      preferProvider,
      abort.signal,
    );

    // Cancelled / superseded mid-generation → nothing left to do.
    if (this.currentCandidate?.id !== id) return;
    if (this.state !== 'active') {
      this.clearCandidate();
      return;
    }
    if (!reply) {
      // Nothing usable — drop the card and let the silence fallback speak.
      this.clearCandidate();
      void this.handleAiSilence('timeout');
      return;
    }
    this.finalizeCandidate(id, reply);
  }

  /**
   * Emit an ai.text.candidate event. `streaming=true` while the reply is
   * still being generated (mobile shows a generating state, no countdown);
   * `streaming=false` is the final emit that arms the countdown ring.
   */
  private emitCandidate(id: string, text: string, streaming: boolean): void {
    const llmProvider =
      this.userContext.config?.llm?.provider ??
      this.userContext.template?.defaultLlmProvider ??
      'openai';
    const llmModel =
      this.userContext.config?.llm?.model ??
      this.userContext.template?.defaultLlmModel ??
      'gpt-4o-mini';
    this.emitTyped({
      type: 'ai.text.candidate',
      data: {
        candidateId: id,
        text,
        llmProvider,
        llmModel,
        autoAcceptInMs:
          !streaming && this.autoMode
            ? AgentCallHandler.AUTO_ACCEPT_DELAY_MS
            : null,
        streaming,
      },
    });
  }

  /**
   * Generation finished. Lock in the full text, emit the final card, and
   * either speak immediately (user already hit accept mid-stream) or arm
   * the auto-accept (auto) / safety-cancel (manual) timer.
   */
  private finalizeCandidate(id: string, fullText: string): void {
    const candidate = this.currentCandidate;
    if (!candidate || candidate.id !== id) return;
    candidate.text = fullText;
    candidate.finalized = true;
    this.candidateAbort = null;
    this.logger.log(
      `[Candidate] finalized id=${id} autoMode=${this.autoMode} acceptedEarly=${candidate.acceptedEarly} text="${fullText.slice(0, 40)}…"`,
    );
    this.emitCandidate(id, fullText, false);

    if (candidate.acceptedEarly) {
      this.resolveCandidate(id, true);
      return;
    }
    candidate.timer = setTimeout(
      () => {
        if (this.autoMode) this.resolveCandidate(id, true);
        else this.resolveCandidate(id, false);
      },
      this.autoMode
        ? AgentCallHandler.AUTO_ACCEPT_DELAY_MS
        : AgentCallHandler.MANUAL_TIMEOUT_MS,
    );
  }

  /** Drop the in-flight candidate: abort its generation, clear its timer. */
  private clearCandidate(): void {
    this.candidateAbort?.abort();
    this.candidateAbort = null;
    if (this.currentCandidate?.timer) clearTimeout(this.currentCandidate.timer);
    this.currentCandidate = null;
  }

  /**
   * Resolve the current candidate (if id matches). Idempotent on stale
   * ids. If accept lands while the reply is still streaming we remember it
   * and speak the moment generation finalizes. ACCEPT (finalized) → speak
   * via session.say() and emit ai.text.final. CANCEL → drop it (aborting
   * generation if still running) and re-arm the idle probe.
   */
  private resolveCandidate(candidateId: string, accepted: boolean): void {
    const candidate = this.currentCandidate;
    if (!candidate || candidate.id !== candidateId) return;

    if (accepted && !candidate.finalized) {
      candidate.acceptedEarly = true;
      this.logger.log(
        `[Candidate] ${candidateId} → ACCEPT (waiting for stream to finish)`,
      );
      return;
    }

    const text = candidate.text;
    this.clearCandidate();
    this.logger.log(
      `[Candidate] ${candidateId} → ${accepted ? 'ACCEPT (speaking)' : 'CANCEL'}`,
    );
    if (accepted) {
      // Speak via the proven say() path (same as greeting/fallback).
      // onAiFinal emits the ai.text.final bubble + records the turn +
      // re-arms the idle probe. We emit the bubble first so it lands
      // as the voice begins.
      this.onAiFinal(text);
      void this.safeSay(text, AgentCallHandler.TTS_SAY_TIMEOUT_MS, {
        allowInterruptions: true,
        addToChatCtx: true,
      }).then((result) => {
        if (!result.ok) {
          reportError(
            this.logger,
            '[Candidate] safeSay failed for accepted reply',
            result.error,
            { conversationId: this.conversationId, reason: result.reason },
          );
        }
      });
    } else {
      // Cancelled — nothing spoken. Re-arm idle probe so we still
      // notice if the interlocutor goes quiet after this.
      this.armIdleProbe();
    }
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

  /**
   * Speak a generic fallback line when reply generation yields nothing
   * usable (timeout, LLM error, anything). The goal is "never let the
   * called party listen to silence" — even a "give me a sec" beats a
   * dead line. We rotate through a small set of phrases so back-to-back
   * fallbacks don't sound stuck.
   *
   * Marked `allowInterruptions: true` so a later real reply cleanly
   * overrides this placeholder instead of queueing behind it.
   */
  private async handleAiSilence(
    reason: 'timeout' | 'plugin_error',
  ): Promise<void> {
    if (!this.session) return;
    if (this.state !== 'active') return;
    // If the SIP participant has just hung up, LiveKit Agents starts
    // draining the session asynchronously — any new say() call will
    // throw "cannot schedule new speech, the agent is draining". That
    // exception bubbles into safeSay → triggers our fatal-end branch
    // and emits a phantom TTS_UNAVAILABLE modal even though the call
    // is already ending for a non-TTS reason (participant disconnect).
    // If there's no remote participant present anymore, skip the
    // fallback — the regular RoomEvent.Disconnected flow will end the
    // call with the correct reason.
    if (!this.room || this.room.remoteParticipants.size === 0) {
      this.logger.debug(
        `[AI fallback] Skipped — no remote participants (room draining).`,
      );
      return;
    }
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

    this.emitTyped({
      type: 'transcript.final',
      data: {
        // Carry the id so api-gateway persists the Message under it and the
        // parallel suggestions.generated (parentMessageId=messageId) FK holds.
        messageId,
        text,
        sttProvider: this.userContext.config?.stt?.provider ?? 'deepgram',
      },
    });
    this.publishLegacyFinal('user', text);

    if (this.conversationId && this.userContext.template) {
      // Main reply: generate (streaming) → present as a candidate (NOT
      // auto-spoken). This is the primary turn now that the session has no
      // LLM — generateAndPresentReply emits ai.thinking, streams the reply
      // into a live candidate card, then finalizes or falls back to silence.
      void this.generateAndPresentReply(text);

      // Quick replies in parallel — best-effort chips the user can tap
      // instead of waiting for / accepting the main candidate. Never
      // blocks the main turn.
      void this.suggestions.generateAndEmit({
        conversationId: this.conversationId,
        parentMessageId: messageId,
        parentMessageText: text,
        systemPrompt: this.userContext.template.systemPrompt,
        recentMessages: this.recentMessages.slice(),
        language: this.userContext.template.language,
        userId: this.userContext.userId,
        styleId: this.userContext.activeStyleId,
      });
    }
  }

  private onAiFinal(text: string): void {
    // AI replied — re-arm the idle probe because now we're back to
    // waiting on the interlocutor.
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

  // ─── Hard call-duration deadline ───────────────────────

  private armCallDeadline(): void {
    this.clearCallDeadline();
    const cap = this.userContext.maxCallDurationSeconds;
    // cap can legitimately be 0 (BillingService returns 0 when the user
    // has zero remaining balance) — in that case the call should already
    // have been refused upstream by assertEligible, so reaching here
    // implies a bug. Defaulting to DEFAULT_CALL_DEADLINE_MS keeps us safe
    // either way: even a buggy upstream can't strand a session forever.
    const deadlineMs =
      cap && cap > 0
        ? cap * 1000
        : AgentCallHandler.DEFAULT_CALL_DEADLINE_MS;
    this.callDeadlineTimer = setTimeout(() => {
      void this.fireCallDeadline(deadlineMs);
    }, deadlineMs);
    this.logger.log(
      `[Deadline] Armed call-duration watchdog: ${Math.round(deadlineMs / 1000)}s`,
    );
  }

  private clearCallDeadline(): void {
    if (this.callDeadlineTimer) {
      clearTimeout(this.callDeadlineTimer);
      this.callDeadlineTimer = null;
    }
  }

  /**
   * Fire the deadline: emit a system-initiated CALL_TIMEOUT and run the
   * same teardown path as user-stop. We deliberately do NOT call
   * `stop()` here because stop()'s state guard would short-circuit
   * (we already moved to 'ending' via beginEnd) AND its own emitTyped
   * would double-fire call.ended with the wrong reason. Instead we
   * inline the two teardown steps (deleteRoom + cleanup) that the
   * stop() path is responsible for.
   */
  private async fireCallDeadline(deadlineMs: number): Promise<void> {
    if (this.state !== 'active') return;
    const durationMs = this.callStartTime ? Date.now() - this.callStartTime : deadlineMs;
    this.logger.warn(
      `[Deadline] Call exceeded max duration (${Math.round(deadlineMs / 1000)}s) — force-ending.`,
    );
    this.beginEnd('system', 'timeout', CallErrorCode.CALL_TIMEOUT);
    this.emitTyped({
      type: 'call.ended',
      data: {
        endedBy: 'system',
        reason: 'timeout',
        errorCode: CallErrorCode.CALL_TIMEOUT,
        durationMs,
      },
    });
    await this.deleteRoomWithRetry();
    this.cleanup();
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

