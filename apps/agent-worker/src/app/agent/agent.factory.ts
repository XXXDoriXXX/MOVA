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
  /** 'sip' for outbound PSTN calls, 'peer' for incoming app-to-app calls.
   *  Drives interlocutor-participant detection in AgentCallHandler. */
  callType?: 'sip' | 'peer';
  /** Display name of the hearing caller on a peer (incoming) call. */
  callerName?: string;
  /** Legacy fields kept for back-compat with the existing LiveKit Agents pipeline. */
  userName: string;
  userRole: string;
  callReason: string;
  config?: AgentConfigDto;
  /**
   * Hard upper bound on call duration, set by billing eligibility at
   * call dispatch time. agent-worker's deadline-watchdog uses this to
   * force-end the call at the cap so a crashed/leaked SIP participant
   * never accrues unbounded telco/LLM charges. Optional for back-compat
   * with legacy contexts; missing/0 disables the watchdog.
   */
  maxCallDurationSeconds?: number;
  /**
   * Resolved conversation-style prompt block (output of
   * StyleResolverService.resolve()). Injected into the LLM's system
   * prompt as a TONE section so the main agent voice — not just
   * suggestions — actually honours the user's chosen style. Populated
   * by AgentCallHandler.start() right before createSession; absent
   * means "no style adaptation" (PERSONAL fallback to FRIENDLY).
   */
  styleInstructions?: string | null;
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
      effectiveModel: string | null;
      viaFallback: boolean;
    };
    /** Provider snapshots so the caller can broadcast the active call
     *  config to the mobile UI for at-a-glance visibility. */
    sttProvenance: { provider: string; model: string };
    ttsProvenance: { provider: string; voice: string };
  }> {
    const sttResolved = this.sttFactory.resolve(context.config);
    const llmResolved = this.llmFactory.resolve(context.config);
    const ttsResolved = this.ttsFactory.resolve(context.config);

    sttResolved.stt.on('error', this.createErrorHandler('STT'));
    ttsResolved.tts.on('error', this.createErrorHandler('TTS'));

    const minEndpointingDelay = context.config?.tts?.minEndpointingDelay ?? 500;
    const maxEndpointingDelay = context.config?.tts?.maxEndpointingDelay ?? 1500;

    // IMPORTANT: the session is built WITHOUT an llm. We do NOT want
    // LiveKit's STT→LLM→TTS auto-pipeline — that auto-speaks every
    // reply, which fights the preview-before-speak gate (and trying to
    // intercept ttsNode broke the stream lifecycle with
    // "WritableStream is closed"). With no llm, the framework does STT
    // only and never auto-generates; `session.say()` still works for
    // TTS. AgentCallHandler generates each reply itself (via
    // SuggestionsService.generateReply), shows it as a candidate, and
    // speaks it through session.say() on accept. llmResolved is still
    // returned for provenance + so the handler knows which provider to
    // ask for the manual generation.
    const session = new voice.AgentSession({
      stt: sttResolved.stt,
      tts: ttsResolved.tts,
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
        effectiveProvider: llmResolved.effectiveProvider,
        requestedProvider: llmResolved.requestedProvider,
        effectiveModel: llmResolved.effectiveModel,
        viaFallback: llmResolved.viaFallback,
      },
      sttProvenance: { provider: sttResolved.provider, model: sttResolved.model },
      ttsProvenance: { provider: ttsResolved.provider, voice: ttsResolved.voice },
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

  /** Public alias of createSystemPrompt for callers that need to assemble
   *  their own Agent subclass (e.g. the gated-TTS wrapper in
   *  agent-call.handler). Kept thin so the prompt construction logic
   *  stays a single source of truth. */
  buildSystemPrompt(ctx: AgentContext): string {
    return this.createSystemPrompt(ctx);
  }

  private createSystemPrompt(ctx: AgentContext): string {
    // Prompt assembled in four sections — order matters: PERSONA first
    // (LLM uses earliest content to anchor "who am I"), then PURPOSE
    // (so "why are you calling?" never gets a confused answer), then
    // TONE (style adaptation), then RULES (operational hygiene). Each
    // section is a discrete block the LLM can attend to independently.
    //
    // Previous version had two showstopper bugs that produced the
    // "I don't know, must have dialed by mistake" behaviour the user
    // saw in production:
    //
    //   1. The operational guard contained the literal sentence
    //      `If you cannot answer, say: "Вибачте, я не знаю — передам
    //      це питання людині."`. LLMs treat verbatim quotes in
    //      instructions as canonical responses — when the interlocutor
    //      asked something not covered by the template (including
    //      "why are you calling?"), the model just emitted that
    //      sentence. Removed; replaced with a softer guideline that
    //      says "answer honestly from context, don't fabricate".
    //
    //   2. The same guard told the model "never say 'я передам це
    //      людині'" — but the fallback line it was supposed to say
    //      contained exactly that phrase. Self-contradiction confused
    //      the model further. Both gone now.
    //
    // The third improvement is splicing the resolved style block into
    // the prompt itself (ctx.styleInstructions). Before, style only
    // affected SuggestionsService; the main agent's voice ignored
    // whatever the user picked in the drawer. Now FRIENDLY / OFFICIAL
    // / PERSONAL / custom styles change how the LLM actually speaks
    // to the interlocutor.

    const persona = this.buildPersonaSection(ctx);
    const purpose = this.buildPurposeSection(ctx);
    const tone = this.buildToneSection(ctx);
    const rules = this.buildRulesSection();

    return [persona, purpose, tone, rules]
      .filter((s) => s && s.length > 0)
      .join('\n\n');
  }

  /**
   * PERSONA — who the LLM is impersonating on the line. Drawn from the
   * user's template when present (the template's systemPrompt is the
   * primary identity contract); falls back to a name-only line when
   * no template is wired. We deliberately repeat "ти телефонуєш" in
   * the legacy fallback so the model never doubts it initiated the
   * call (the "dialed by mistake" failure mode came from the LLM
   * thinking it was the one being called).
   */
  private buildPersonaSection(ctx: AgentContext): string {
    const fromTemplate = ctx.template?.systemPrompt?.trim();
    if (fromTemplate) {
      // Wrap the user's free-form prompt in an explicit marker so it
      // doesn't blur into the rules below. The LLM sees "this is who
      // I am" as a header, not just opening prose.
      return `# Хто ти\n${fromTemplate}`;
    }
    const userName = ctx.userName?.trim() || 'абонент';
    const userRole = ctx.userRole?.trim();
    const identityLine = userRole
      ? `Ти — ${userName}, ${userRole}. Ти телефонуєш, бо тобі потрібна допомога — не помилково.`
      : `Ти — ${userName}. Ти телефонуєш, бо тобі потрібна допомога — не помилково.`;
    return `# Хто ти\n${identityLine}\nКористуєшся голосовим асистентом, бо не чуєш — це нормально, цього не треба пояснювати співрозмовнику.`;
  }

  /**
   * PURPOSE — explicit reason for the call. Pulled from the legacy
   * `callReason` field (still present in many templates' contexts)
   * when a structured template isn't carrying it via systemPrompt.
   *
   * Critically: if neither template.systemPrompt nor callReason gives
   * us a concrete purpose, we DON'T leave this section empty — we
   * give the LLM a humble graceful answer for "why are you calling"
   * that doesn't break character. Empty purpose was the gateway to
   * the "I don't know, dialed by mistake" bug.
   */
  private buildPurposeSection(ctx: AgentContext): string {
    const callReason = ctx.callReason?.trim();
    if (callReason) {
      return `# Навіщо телефонуєш\n${callReason}\nЯкщо співрозмовник питає "чому дзвонив" — відповідай саме це, своїми словами, без шаблонної відповіді.`;
    }
    // Template's systemPrompt usually folds purpose into persona; if
    // it does, this section becomes the "answer honestly" instruction
    // and the LLM has the template's identity to draw from.
    if (ctx.template?.systemPrompt) {
      return `# Як відповідати на "чому дзвониш"\nДивись свою роль вище і поясни мету конкретно (наприклад "уточнити графік", "записатися", "дізнатись про…"). НЕ кажи що помилився номером — ти знав куди телефонував.`;
    }
    // No template and no reason — last-resort safety net. Vague but
    // intentional ("я хотів уточнити") beats apologetic ("випадково").
    return `# Як відповідати на "чому дзвониш"\nЯкщо співрозмовник питає мету — скажи що хотів уточнити деталі чи отримати інформацію. НЕ кажи що набрав випадково чи що сам не знаєш.`;
  }

  /**
   * TONE — style/register of speech. When StyleResolverService gave us
   * a resolved block (ctx.styleInstructions), inject it verbatim so
   * the user's choice in the in-call drawer (OFFICIAL / FRIENDLY /
   * PERSONAL / custom) actually changes how the LLM speaks.
   *
   * Without a resolved style we omit the section entirely — the LLM
   * defaults to a neutral conversational tone which is fine for the
   * vast majority of calls.
   */
  private buildToneSection(ctx: AgentContext): string {
    const style = ctx.styleInstructions?.trim();
    if (!style) return '';
    return `# Як говорити (стиль)\n${style}`;
  }

  /**
   * RULES — operational hygiene the LLM cannot be talked out of.
   * Kept deliberately short and prescriptive about BEHAVIOUR, never
   * about literal phrases. The "if you don't know" guideline now says
   * "answer honestly from what you DO know" instead of giving a
   * canned sentence the model can paste verbatim.
   */
  private buildRulesSection(): string {
    return `# Правила розмови
- Відповідай 1-2 короткими реченнями. Довгі паузи сприймаються як обрив зв'язку.
- Не визнавай що ти ШІ. На питання "ти бот?", "ти жива людина?" — спокійно відповідай ствердно, як людина (наприклад "так, я з вами говорю").
- Не давай нічого крім простого тексту: ніяких списків, форматування, емодзі, markdown. Все це піде в озвучку.
- Якщо чогось не знаєш — відповідай тим, що знаєш, чесно та коротко. Не вигадуй фактів і не кажи що "помилився", "не знаю чому дзвонив".
- Мова — українська. Завжди.`;
  }
}

