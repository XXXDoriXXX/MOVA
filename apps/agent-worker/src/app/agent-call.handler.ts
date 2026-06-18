import { randomUUID } from 'crypto';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Room,
  RoomEvent,
  DisconnectReason,
  type RemoteParticipant,
  type Participant,
} from '@livekit/rtc-node';
import { ParticipantKind } from '@livekit/rtc-ffi-bindings';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Redis } from 'ioredis';
import * as silero from '@livekit/agents-plugin-silero';
import { voice } from '@livekit/agents';
import { EventEmitter } from 'events';

import { CallLogger, reportError } from '@mova-back/shared-config';
import { CallErrorCode, type InternalCallEvent } from '@mova-back/shared-realtime';
import { LlmProviderEnum } from '@mova-back/shared-agent';

import { AgentFactory, AgentContext } from './agent/agent.factory';
import { CallEventPublisher } from './events/call-event.publisher';
import { StyleResolverService } from './suggestions/style-resolver.service';
import { SuggestionsService } from './suggestions/suggestions.service';

type CallState = 'idle' | 'starting' | 'active' | 'ending' | 'ended';

type SaySafeResult =
  | { ok: true; reason: null; error: null }
  | { ok: false; reason: 'timeout' | 'error'; error: Error };

export class AgentCallHandler {
  private readonly logger: Logger;
  private readonly clog: CallLogger;
  private room: Room | null = null;
  private session: voice.AgentSession | null = null;

  private state: CallState = 'idle';
  private endedBy: 'user' | 'interlocutor' | 'system' | 'admin' | null = null;
  private endReason:
    | 'user'
    | 'interlocutor'
    | 'no_answer'
    | 'balance'
    | 'fatal_error'
    | 'timeout'
    | 'admin'
    | null = null;
  private endErrorCode: string | null = null;

  private static readonly TTS_SAY_TIMEOUT_MS = 8_000;
  private static readonly TTS_GREETING_TIMEOUT_MS = 12_000;

  private static readonly DELETE_ROOM_RETRIES = 3;
  private static readonly DELETE_ROOM_BACKOFF_MS = [200, 800, 2_400];

  private sttStallTimer: NodeJS.Timeout | null = null;
  private static readonly STT_STALL_TIMEOUT_MS = 30_000;
  private sttStalledEmitted = false;

  private heartbeatFailures = 0;
  private static readonly HEARTBEAT_FAIL_ALARM = 3;

  private callDeadlineTimer: NodeJS.Timeout | null = null;
  private static readonly DEFAULT_CALL_DEADLINE_MS = 60 * 60 * 1000;

  private readonly recentMessages: Array<{
    role: 'interlocutor' | 'ai' | 'user_typed';
    text: string;
  }> = [];
  private static readonly RECENT_BUFFER_MAX = 10;

  private heartbeatInterval: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 5_000;

  private usageTickInterval: NodeJS.Timeout | null = null;
  private static readonly USAGE_TICK_INTERVAL_MS = 5_000;

  private callStartTime: number | null = null;

  private static readonly FALLBACK_LINES_UA = [
    'Перепрошую, можете повторити?',
    'Вибачте, мене не дуже добре чути. Повторіть, будь ласка.',
    'Дайте мені секунду.',
  ];
  private fallbackCursor = 0;

  private idleProbeTimer: NodeJS.Timeout | null = null;
  private idleProbeCount = 0;
  private participantAnswered = false;
  private answeredAtMs: number | null = null;
  private interlocutorIdentity: string | null = null;
  private lastSipStatus: string | null = null;
  private static readonly SIP_STATUS_ATTR = 'sip.callStatus';
  private static readonly IDLE_FIRST_MS = 18_000;
  private static readonly IDLE_FOLLOWUP_MS = 25_000;
  private static readonly IDLE_MAX_PROBES = 3;
  private static readonly IDLE_PROBES_UA = [
    'Алло? Ви мене чуєте?',
    'Перепрошую, можливо погано чути — ви на лінії?',
    'Здається, нас не чути. Я ще трохи зачекаю і покладу слухавку.',
  ];

  private autoMode = true;
  private static readonly AUTO_ACCEPT_DELAY_MS = 5_000;
  private static readonly MANUAL_TIMEOUT_MS = 60_000;

  private static readonly REPLY_TIER_DISPLAY: Record<string, string> = {
    openai: 'gpt-4.1-mini',
    gemini: 'gemini-2.5-flash',
    anthropic: 'claude-haiku-4-5',
    groq: 'llama-3.1-8b-instant',
  };

  private currentCandidate: {
    id: string;
    text: string;
    timer: NodeJS.Timeout | null;
    finalized: boolean;
    acceptedEarly: boolean;
  } | null = null;

  private candidateAbort: AbortController | null = null;

  private turnText = '';
  private turnDebounceTimer: NodeJS.Timeout | null = null;
  private static readonly TURN_DEBOUNCE_MS = 1_500;

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
    this.clog = new CallLogger(this.logger, {
      conversationId: userContext.conversationId ?? null,
      roomName,
      userId: userContext.userId ?? null,
      callType: userContext.callType ?? 'sip',
    });
  }

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
    this.clog.event('agent.start', { callType: this.userContext.callType ?? 'sip' });

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
      this.room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        this.handleInterlocutorPresent(p, false);
      });
      this.room.on(
        RoomEvent.ParticipantAttributesChanged,
        (changed: Record<string, string>, p: Participant) => {
          if (p.kind !== ParticipantKind.SIP) return;
          const status =
            changed[AgentCallHandler.SIP_STATUS_ATTR] ?? this.sipStatusOf(p);
          if (!status || status === this.lastSipStatus) return;
          this.lastSipStatus = status;
          this.logger.log(
            `📡 [Call Lifecycle] SIP status → ${status} (identity=${p.identity}).`,
          );
          this.clog.event('agent.sip.status', {
            identity: p.identity,
            sipStatus: status,
            statusCode: changed['sip.callStatusCode'] ?? null,
            sinceDialMs: this.callStartTime ? Date.now() - this.callStartTime : 0,
          });
          if (status === 'active') {
            this.markInterlocutorAnswered(p, false);
          }
        },
      );
      this.room.on(RoomEvent.Disconnected, () => {
        if (this.state === 'ending' || this.state === 'ended') {
          this.logger.debug(
            `RoomEvent.Disconnected ignored — already ${this.state}.`,
          );
          return;
        }
        const durationMs = Date.now() - callStartTime;
        const wasAnswered = this.participantAnswered;
        this.logger.log(
          `🚪 [Call Lifecycle] Room disconnected after ${durationMs}ms (answered=${wasAnswered}).`,
        );
        this.clog.event('agent.roomDisconnected', { durationMs, wasAnswered });
        const reason = wasAnswered ? 'interlocutor' : 'no_answer';
        const errorCode = wasAnswered ? undefined : CallErrorCode.CALL_UNANSWERED;
        this.beginEnd('interlocutor', reason, errorCode);
        this.emitTyped({
          type: 'call.ended',
          data: {
            endedBy: 'interlocutor',
            reason,
            ...(errorCode ? { errorCode } : {}),
            wasAnswered,
            durationMs,
          },
        });
        this.cleanup();
      });
      this.room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        if (this.state === 'ending' || this.state === 'ended') return;
        if (!this.interlocutorIdentity || p.identity !== this.interlocutorIdentity) {
          return;
        }
        const durationMs = Date.now() - callStartTime;
        const reasonName = this.disconnectReasonName(p);
        const wasAnswered = this.participantAnswered;
        const sipStatus = this.sipStatusOf(p) ?? this.lastSipStatus;
        this.logger.log(
          `🚪 [Call Lifecycle] Interlocutor disconnected (identity=${p.identity}) ` +
            `reason=${reasonName} answered=${wasAnswered} sipStatus=${sipStatus ?? 'n/a'} after ${durationMs}ms.`,
        );
        const cls = this.classifyInterlocutorEnd(reasonName, wasAnswered);
        this.clog.event('agent.interlocutorDisconnected', {
          identity: p.identity,
          durationMs,
          disconnectReason: reasonName,
          sipStatus: sipStatus ?? null,
          wasAnswered,
          endReason: cls.reason,
          errorCode: cls.errorCode ?? null,
        });
        this.beginEnd(cls.endedBy, cls.reason, cls.errorCode);
        this.emitTyped({
          type: 'call.ended',
          data: {
            endedBy: cls.endedBy,
            reason: cls.reason,
            ...(cls.errorCode ? { errorCode: cls.errorCode } : {}),
            wasAnswered,
            durationMs,
          },
        });
        this.cleanup();
      });

      await this.room.connect(wsURL, token);
      this.logger.log(`✅ [WebRTC] Agent joined room`);
      this.clog.event('agent.roomConnected', { joinMs: Date.now() - callStartTime });

      this.emitTyped({ type: 'call.connected', data: {} });

      if (!this.participantAnswered) {
        for (const p of this.room.remoteParticipants.values()) {
          this.handleInterlocutorPresent(p, true);
          if (this.interlocutorIdentity) break;
        }
      }

      this.startHeartbeat();

      try {
        this.userContext.styleInstructions = await this.styleResolver.resolve(
          this.userContext.userId ?? null,
          this.userContext.activeStyleId,
        );
      } catch (err) {
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

      phase = 'greeting';
      const greetingText = this.agentFactory.getInitialGreeting(this.userContext);
      const greetingResult = await this.safeSay(
        greetingText,
        AgentCallHandler.TTS_GREETING_TIMEOUT_MS,
        { allowInterruptions: false },
      );
      if (!greetingResult.ok) {
        throw new Error(
          `Greeting TTS ${greetingResult.reason}: ` +
            (greetingResult.error?.message ?? 'no error detail'),
        );
      }
      this.emitTyped({
        type: 'ai.text.final',
        data: { text: greetingText, llmProvider: 'greeting', llmModel: 'static' },
      });
      this.state = 'active';
      this.armIdleProbe();
      this.armSttStall();
      // armCallDeadline / armUsageTick are NOT armed here: the call may still be
      // ringing (participantAnswered is false). The max-duration budget and the
      // seconds-remaining countdown must count from ANSWER, not room-connect, or
      // ringback time is billed against the user's quota and cuts the actual
      // conversation short. They are armed in markInterlocutorAnswered instead
      // (CLAUDE.md rule 4: arm watchdogs at the real lifecycle edge).

      this.logger.log(
        `🎉 [Call Lifecycle] Connection sequence completed in ${Date.now() - callStartTime}ms`,
      );
      this.clog.event('agent.active', { setupMs: Date.now() - callStartTime });
      phase = 'done';
    } catch (error) {
      const err = error as Error;
      const errorCode: string = (() => {
        switch (phase) {
          case 'config':
          case 'token':
            return CallErrorCode.FATAL_INTERNAL;
          case 'room_connect':
            return CallErrorCode.LIVEKIT_DISCONNECTED;
          case 'session_init':
            return CallErrorCode.LLM_UNAVAILABLE;
          case 'greeting':
            return CallErrorCode.TTS_UNAVAILABLE;
          default:
            return CallErrorCode.AGENT_LOST;
        }
      })();
      this.clog.error('agent.fatal', err, { phase, errorCode });
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
    // The user is taking over this turn (manual text or a chosen suggestion).
    // Cancel any *pending* AI candidate + its auto-accept timer, or it would
    // ALSO be queued — putting a sentence the deaf user never chose into the
    // interlocutor's ear (double-speak). We deliberately do NOT interrupt the
    // speech that is already playing: every message is voiced to the end, and
    // this one queues behind it (non-interruptible say() calls serialise).
    this.clearCandidate();
    const result = await this.safeSay(
      text,
      AgentCallHandler.TTS_SAY_TIMEOUT_MS,
      { allowInterruptions: false, addToChatCtx: true },
    );
    if (result.ok) {
      this.recordRecent('user_typed', text);
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

  async stopTts(): Promise<void> {
    if (!this.session) return;
    try {
      this.session.interrupt();
    } catch (err) {
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

  async stop(): Promise<void> {
    if (this.state === 'ending' || this.state === 'ended') {
      this.logger.debug(`stop() ignored — already ${this.state}.`);
      return;
    }
    const durationMs = this.callStartTime ? Date.now() - this.callStartTime : 0;
    this.clog.event('agent.stop', { durationMs });
    this.beginEnd('user', 'user');
    this.emitTyped({
      type: 'call.ended',
      data: { endedBy: 'user', reason: 'user', durationMs },
    });
    await this.deleteRoomWithRetry();
    this.cleanup();
  }

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

  private cleanup(): void {
    if (this.state === 'ended') {
      this.logger.debug('cleanup() ignored — already ended.');
      return;
    }
    if (this.state !== 'ending') this.state = 'ending';
    this.stopHeartbeat();
    this.clearIdleProbe();
    this.clearSttStall();
    this.clearCallDeadline();
    this.clearUsageTick();
    this.clearCandidate();
    this.clearTurn();
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

  private sipStatusOf(p: Participant): string | undefined {
    return p.attributes?.[AgentCallHandler.SIP_STATUS_ATTR];
  }

  private disconnectReasonName(p: Participant): string {
    const code = p.disconnectReason;
    if (code === undefined || code === null) return 'UNKNOWN';
    return DisconnectReason[code] ?? String(code);
  }

  private classifyInterlocutorEnd(
    reasonName: string,
    wasAnswered: boolean,
  ): {
    endedBy: 'interlocutor' | 'system';
    reason: 'interlocutor' | 'no_answer' | 'fatal_error';
    errorCode?: string;
  } {
    if (wasAnswered) {
      return { endedBy: 'interlocutor', reason: 'interlocutor' };
    }
    switch (reasonName) {
      case 'USER_REJECTED':
        return {
          endedBy: 'interlocutor',
          reason: 'no_answer',
          errorCode: CallErrorCode.CALL_DECLINED,
        };
      case 'SIP_TRUNK_FAILURE':
      case 'JOIN_FAILURE':
        return {
          endedBy: 'system',
          reason: 'fatal_error',
          errorCode: CallErrorCode.LIVEKIT_DISCONNECTED,
        };
      case 'USER_UNAVAILABLE':
      case 'CONNECTION_TIMEOUT':
      default:
        return {
          endedBy: 'interlocutor',
          reason: 'no_answer',
          errorCode: CallErrorCode.CALL_UNANSWERED,
        };
    }
  }

  private handleInterlocutorPresent(p: Participant, alreadyPresent: boolean): void {
    if (this.participantAnswered) return;
    const isPeer = this.userContext.callType === 'peer';
    if (!isPeer && p.kind !== ParticipantKind.SIP) return;

    this.interlocutorIdentity = p.identity;

    if (isPeer) {
      this.markInterlocutorAnswered(p, alreadyPresent);
      return;
    }

    const status = this.sipStatusOf(p);
    if (status) this.lastSipStatus = status;
    this.clog.event('agent.sip.present', {
      identity: p.identity,
      sipStatus: status ?? null,
      alreadyPresent,
    });
    if (status === 'active') {
      this.markInterlocutorAnswered(p, alreadyPresent);
      return;
    }
    this.logger.log(
      `📲 [Call Lifecycle] SIP leg ${status ?? 'dialing'} (identity=${p.identity}) — waiting for pickup.`,
    );
  }

  private markInterlocutorAnswered(p: Participant, alreadyPresent: boolean): void {
    if (this.participantAnswered) return;
    this.participantAnswered = true;
    this.answeredAtMs = Date.now();
    this.interlocutorIdentity = p.identity;
    const waitedMs = this.callStartTime ? Date.now() - this.callStartTime : 0;
    this.logger.log(
      `📞 [Call Lifecycle] Interlocutor answered (identity=${p.identity}) after ${waitedMs}ms.`,
    );
    this.clog.event('agent.answered', {
      identity: p.identity,
      kind: String(p.kind),
      sipStatus: this.sipStatusOf(p) ?? null,
      waitedMs,
      alreadyPresent,
    });
    this.emitTyped({
      type: 'call.answered',
      data: { participantIdentity: p.identity },
    });
    this.armSttStall();
    this.armIdleProbe();
    // The max-duration budget and the seconds-remaining countdown start NOW, at
    // answer — not at room-connect — so ringback never eats the user's quota.
    this.armCallDeadline();
    this.armUsageTick();
  }

  private beginEnd(
    endedBy: 'user' | 'interlocutor' | 'system' | 'admin',
    reason:
      | 'user'
      | 'interlocutor'
      | 'no_answer'
      | 'balance'
      | 'fatal_error'
      | 'timeout'
      | 'admin',
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

      this.clearIdleProbe();
      this.idleProbeCount = 0;
      this.armSttStall();

      this.bufferInterlocutorChunk(text, Boolean(ev['isFinal']));
    });

    sessionEmitter.on('error', (err: Record<string, unknown> | Error) => {
      if (this.state === 'ending' || this.state === 'ended') return;
      const innerError = (
        err && 'error' in (err as object) ? (err as { error: Error }).error : err
      ) as Error;
      if (innerError?.name === 'APIUserAbortError' || innerError?.message?.includes('aborted')) {
        return;
      }
      const source = (err as { source?: { constructor?: { name?: string } } } | null)
        ?.source?.constructor?.name?.toLowerCase() ?? '';
      const providerType: 'stt' | 'llm' | 'tts' =
        source.includes('stt') ? 'stt' : source.includes('tts') ? 'tts' : 'llm';
      reportError(this.logger, '[AgentSession] plugin error', innerError, {
        conversationId: this.conversationId,
        providerType,
        sourceClass: source || 'unknown',
      });
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

  setAutoMode(enabled: boolean): void {
    if (this.autoMode === enabled) return;
    this.autoMode = enabled;
    const candidate = this.currentCandidate;
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
    } else {
      // Manual mode still needs a fallback timer — mirror finalizeCandidate's
      // manual path — or toggling auto-mode OFF leaves the finalized candidate
      // with no timer and the card lingers forever with no auto-resolution.
      candidate.timer = setTimeout(
        () => this.resolveCandidate(candidate.id, false),
        AgentCallHandler.MANUAL_TIMEOUT_MS,
      );
    }
    this.emitCandidate(candidate.id, candidate.text, false);
    this.logger.log(`[Candidate] auto-mode → ${enabled ? 'ON' : 'OFF'}`);
  }

  acceptAiReply(candidateId: string): void {
    this.resolveCandidate(candidateId, true);
  }

  cancelAiReply(candidateId: string): void {
    this.resolveCandidate(candidateId, false);
  }

  private async generateAndPresentReply(parentText: string): Promise<void> {
    if (!this.conversationId || !this.userContext.template) return;
    this.clearCandidate();

    this.emitTyped({ type: 'ai.thinking', data: {} });

    const preferProvider = this.userContext.config?.llm?.provider as
      | LlmProviderEnum
      | undefined;
    const modelOverride =
      this.userContext.config?.llm?.model ??
      this.userContext.template?.defaultLlmModel ??
      undefined;

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
        if (this.currentCandidate?.id !== id) return;
        this.currentCandidate.text = cumulative;
        const now = Date.now();
        if (now - lastEmit < 120) return;
        lastEmit = now;
        this.emitCandidate(id, cumulative, true);
      },
      preferProvider,
      modelOverride,
      abort.signal,
    );

    if (this.currentCandidate?.id !== id) return;
    if (this.state !== 'active') {
      this.clearCandidate();
      return;
    }
    if (!reply) {
      this.clearCandidate();
      void this.handleAiSilence('timeout');
      return;
    }
    this.finalizeCandidate(id, reply);
  }

  private emitCandidate(id: string, text: string, streaming: boolean): void {
    const llmProvider =
      this.userContext.config?.llm?.provider ??
      this.userContext.template?.defaultLlmProvider ??
      'openai';
    const llmModel =
      this.userContext.config?.llm?.model ??
      this.userContext.template?.defaultLlmModel ??
      AgentCallHandler.REPLY_TIER_DISPLAY[llmProvider] ??
      'gpt-4.1-mini';
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

  private clearCandidate(): void {
    this.candidateAbort?.abort();
    this.candidateAbort = null;
    if (this.currentCandidate?.timer) clearTimeout(this.currentCandidate.timer);
    this.currentCandidate = null;
  }

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
      this.onAiFinal(text);
      void this.safeSay(text, AgentCallHandler.TTS_SAY_TIMEOUT_MS, {
        allowInterruptions: false,
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
      this.armIdleProbe();
    }
  }

  private armIdleProbe(): void {
    this.clearIdleProbe();
    if (!this.participantAnswered) return;
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
    if (!this.room || this.room.remoteParticipants.size === 0) {
      this.clog.debug('agent.idleProbe.skippedDraining');
      return;
    }
    if (this.idleProbeCount >= AgentCallHandler.IDLE_MAX_PROBES) {
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
      { allowInterruptions: false },
    );
    if (result.ok) {
      this.idleProbeCount += 1;
      this.recordRecent('ai', line);
      this.emitTyped({
        type: 'ai.text.final',
        data: { text: line, llmProvider: 'idle_probe', llmModel: 'static' },
      });
      this.armIdleProbe();
    } else {
      reportError(this.logger, '[Idle probe] safeSay failed — will retry', result.error, {
        conversationId: this.conversationId,
        reason: result.reason,
      });
      this.armIdleProbe();
    }
  }

  private async handleAiSilence(
    reason: 'timeout' | 'plugin_error',
  ): Promise<void> {
    if (!this.session) return;
    if (this.state !== 'active') return;
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
      { allowInterruptions: false },
    );
    if (result.ok) {
      this.recordRecent('ai', line);
      this.emitTyped({
        type: 'ai.text.final',
        data: {
          text: line,
          llmProvider: 'fallback',
          llmModel: 'static',
        },
      });
    } else {
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

  private bufferInterlocutorChunk(text: string, isFinal: boolean): void {
    const cumulative = this.turnText ? `${this.turnText} ${text}` : text;
    this.emitTyped({ type: 'transcript.partial', data: { text: cumulative } });
    this.publishLegacyInterim('user', cumulative);

    if (!isFinal) return;

    const firstFinalOfTurn = this.turnText === '';
    if (firstFinalOfTurn) {
      this.clearCandidate();
      this.emitTyped({ type: 'ai.thinking', data: {} });
    }
    this.turnText = cumulative;
    if (this.turnDebounceTimer) clearTimeout(this.turnDebounceTimer);
    this.turnDebounceTimer = setTimeout(
      () => this.commitTurn(),
      AgentCallHandler.TURN_DEBOUNCE_MS,
    );
  }

  private clearTurn(): void {
    if (this.turnDebounceTimer) {
      clearTimeout(this.turnDebounceTimer);
      this.turnDebounceTimer = null;
    }
    this.turnText = '';
  }

  private commitTurn(): void {
    this.turnDebounceTimer = null;
    const text = this.turnText.trim();
    this.turnText = '';
    if (!text) return;
    if (this.state !== 'active') return;

    const messageId = randomUUID();
    this.recordRecent('interlocutor', text);

    this.emitTyped({
      type: 'transcript.final',
      data: {
        messageId,
        text,
        sttProvider: this.userContext.config?.stt?.provider ?? 'deepgram',
      },
    });
    // Authoritative end-of-turn: the debounce elapsed, so the interlocutor has
    // really stopped. Lets the client seal the bubble at the true endpoint
    // instead of guessing with its own silence timer.
    this.emitTyped({ type: 'transcript.turn_end', data: { messageId } });
    this.publishLegacyFinal('user', text);

    if (this.conversationId && this.userContext.template) {
      void this.generateAndPresentReply(text);

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
    this.armIdleProbe();
    this.recordRecent('ai', text);
    const llmProvider =
      this.userContext.config?.llm?.provider ??
      this.userContext.template?.defaultLlmProvider ??
      'openai';
    const llmModel =
      this.userContext.config?.llm?.model ??
      this.userContext.template?.defaultLlmModel ??
      AgentCallHandler.REPLY_TIER_DISPLAY[llmProvider] ??
      'gpt-4.1-mini';

    this.emitTyped({
      type: 'ai.text.final',
      data: { text, llmProvider, llmModel },
    });
    this.publishLegacyFinal('agent', text);
  }

  private emitTyped(partial: Pick<InternalCallEvent, 'type' | 'data'>): void {
    if (!this.conversationId) {
      return;
    }
    const event = {
      ...partial,
      conversationId: this.conversationId,
      occurredAt: new Date().toISOString(),
    } as InternalCallEvent;
    this.clog.debug('agent.emit', { type: partial.type });
    void this.publisher.publish(event);
  }

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
    });
    const result = await Promise.race([sayPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    return result;
  }

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
    this.armSttStall();
  }

  private armCallDeadline(): void {
    this.clearCallDeadline();
    // Defensive: the max-duration budget only applies once the call is answered.
    if (!this.participantAnswered) return;
    const cap = this.userContext.maxCallDurationSeconds;
    const deadlineMs =
      cap && cap > 0
        ? cap * 1000
        : AgentCallHandler.DEFAULT_CALL_DEADLINE_MS;
    this.callDeadlineTimer = setTimeout(() => {
      void this.fireCallDeadline(deadlineMs);
    }, deadlineMs);
    this.callDeadlineTimer.unref?.();
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

  private startHeartbeat(): void {
    if (!this.conversationId) return;
    const channel = `heartbeat:${this.conversationId}`;
    const tick = (): void => {
      this.redis
        .publish(channel, JSON.stringify({ ts: Date.now() }))
        .then(() => {
          this.heartbeatFailures = 0;
        })
        .catch((err: Error) => {
          this.heartbeatFailures += 1;
          if (this.heartbeatFailures >= AgentCallHandler.HEARTBEAT_FAIL_ALARM) {
            this.logger.error(
              `Heartbeat publish failed ${this.heartbeatFailures}× in a row — realtime-service likely sees AGENT_LOST. Last error: ${err.message}`,
            );
          } else {
            this.logger.debug(`Heartbeat publish failed: ${err.message}`);
          }
        });
    };
    tick();
    this.heartbeatInterval = setInterval(tick, AgentCallHandler.HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private armUsageTick(): void {
    this.clearUsageTick();
    const cap = this.userContext.maxCallDurationSeconds;
    const planCode = this.userContext.planCode ?? 'free';
    const tick = (): void => {
      if (this.state !== 'active' || !this.answeredAtMs) return;
      // Count from ANSWER, not room-connect: secondsConnected mirrors the
      // billable duration (which also runs from answeredAt), so the user's
      // remaining-seconds counter doesn't drain during ringback.
      const secondsConnected = Math.floor((Date.now() - this.answeredAtMs) / 1000);
      const secondsRemaining =
        cap && cap > 0 ? Math.max(0, cap - secondsConnected) : null;
      this.emitTyped({
        type: 'call.tick',
        data: { secondsConnected, secondsRemaining, planCode },
      });
    };
    this.usageTickInterval = setInterval(tick, AgentCallHandler.USAGE_TICK_INTERVAL_MS);
    this.usageTickInterval.unref?.();
  }

  private clearUsageTick(): void {
    if (this.usageTickInterval) {
      clearInterval(this.usageTickInterval);
      this.usageTickInterval = null;
    }
  }

  private recordRecent(
    role: 'interlocutor' | 'ai' | 'user_typed',
    text: string,
  ): void {
    this.recentMessages.push({ role, text });
    if (this.recentMessages.length > AgentCallHandler.RECENT_BUFFER_MAX) {
      this.recentMessages.shift();
    }
  }

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

