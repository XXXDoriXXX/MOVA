import { Injectable, Logger } from '@nestjs/common';
import { voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { AgentConfigDto } from '@mova-back/shared-agent';
import { SttFactory } from './factories/stt.factory';
import { LlmFactory } from './factories/llm.factory';
import { TtsFactory } from './factories/tts.factory';

export interface AgentContext {
  /** Phase 4+: populated by api-gateway on /calls/start. */
  conversationId?: string;
  /** Phase 4+: who initiated the call. Used for per-conversation publish. */
  userId?: string;
  /** Phase 4+: snapshot of the active Template (system prompt + provider hints). */
  template?: {
    id: string;
    systemPrompt: string;
    language: string;
    defaultLlmProvider: string | null;
    defaultLlmModel: string | null;
    defaultTtsProvider: string | null;
    defaultVoice: string | null;
  } | null;
  /**
   * Active conversation style at call start. Resolved by api-gateway with
   * precedence: user.preferredStyleId > template.defaultStyleId > built-in
   * PERSONAL. Wire format: "builtin:<key>" or "custom:<uuid>". Mutated
   * mid-call via CallControlAction.CHANGE_STYLE.
   */
  activeStyleId?: string;
  /** Legacy fields kept for back-compat with the existing LiveKit Agents pipeline. */
  userName: string;
  userRole: string;
  callReason: string;
  config?: AgentConfigDto;
}

@Injectable()
export class AgentFactory {
  private readonly logger = new Logger(AgentFactory.name);

  constructor(
    private readonly sttFactory: SttFactory,
    private readonly llmFactory: LlmFactory,
    private readonly ttsFactory: TtsFactory,
  ) {}

  createAgent(context: AgentContext): voice.Agent {
    return new voice.Agent({
      instructions: this.createSystemPrompt(context),
    });
  }

  async createSession(
    vad: silero.VAD,
    context: AgentContext,
  ): Promise<{
    session: voice.AgentSession;
    /** Provenance for the LLM the session ended up using. Caller emits a
     *  `provider.failure` (recoverable) event if `viaFallback === true`
     *  so mobile can show a degraded banner from turn 1. */
    llmProvenance: {
      effectiveProvider: string;
      requestedProvider: string;
      viaFallback: boolean;
    };
  }> {
    const stt = this.sttFactory.create(context.config);
    const resolved = this.llmFactory.resolve(context.config);
    const tts = this.ttsFactory.create(context.config);

    stt.on('error', this.createErrorHandler('STT'));
    resolved.llm.on('error', this.createErrorHandler('LLM'));
    tts.on('error', this.createErrorHandler('TTS'));

    const minEndpointingDelay = context.config?.tts?.minEndpointingDelay ?? 500;
    const maxEndpointingDelay = context.config?.tts?.maxEndpointingDelay ?? 1500;

    const session = new voice.AgentSession({
      stt,
      llm: resolved.llm,
      tts,
      vad,
      voiceOptions: {
        allowInterruptions: true,
        minEndpointingDelay,
        maxEndpointingDelay,
      },
    });
    return {
      session,
      llmProvenance: {
        effectiveProvider: resolved.effectiveProvider,
        requestedProvider: resolved.requestedProvider,
        viaFallback: resolved.viaFallback,
      },
    };
  }

  private createErrorHandler(moduleName: string) {
    return (err: Record<string, any> | Error) => {
      const innerError = (err && 'error' in err ? err.error : err) as Error;

      if (innerError?.name === 'APIUserAbortError' || innerError?.message?.includes('aborted')) {
        this.logger.debug(`🛑 [Plugin:${moduleName}] Stream gracefully aborted due to interruption.`);
        return;
      }

      this.logger.error(`❌ [Plugin:${moduleName}] Critical Exception: ${innerError?.message}`, innerError?.stack);
    };
  }

  getInitialGreeting(context: AgentContext): string {
    const name = context.userName?.trim();
    return name
      ? `Доброго дня. Це ${name}. Я використовую асистента, бо не чую.`
      : 'Доброго дня. Я використовую асистента, бо не чую.';
  }

  private createSystemPrompt(ctx: AgentContext): string {
    // Operational guard — appended to every prompt so the LLM can't be
    // talked out of its conversational hygiene even if a user template
    // forgets these rules (concise, no meta-talk, no markdown, UA only).
    const guard = `
# Operational rules for this voice call
- Reply in 1–2 short sentences. Long pauses sound like a dropped line.
- No meta-talk: never reveal you are an AI ("Я штучний інтелект", "Як ШІ-помічник", "Я передам це людині"). You are the person on the line.
- No formatting: no lists, no bold, no italics, no emoji. Plain text only — it goes to TTS.
- If you cannot answer, say: "Вибачте, я не знаю — передам це питання людині."
- Language: Ukrainian only.`.trim();

    // Primary path — the user-authored Template provides identity, situation
    // and intent. Templates are the contract users edit in /templates; the
    // hard-coded fallback below only fires for callers that haven't migrated.
    const fromTemplate = ctx.template?.systemPrompt?.trim();
    if (fromTemplate) {
      return `${fromTemplate}\n\n${guard}`;
    }

    // Legacy fallback for old clients that still send userName/userRole/callReason.
    const userName = ctx.userName?.trim() || 'абонент';
    const userRole = ctx.userRole?.trim();
    const callReason = ctx.callReason?.trim();
    const identityLine = userRole
      ? `Ти — голос ${userName}, ${userRole}. Не чуєш — користуєшся асистентом.`
      : `Ти — голос ${userName}. Не чуєш — користуєшся асистентом.`;
    const reasonLine = callReason ? `Мета дзвінка: ${callReason}.` : '';
    return `# Identity\n${identityLine}\n${reasonLine}\n\n${guard}`.trim();
  }
}

