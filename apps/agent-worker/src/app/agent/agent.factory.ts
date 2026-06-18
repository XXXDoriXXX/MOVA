import { Injectable, Logger } from '@nestjs/common';
import { voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { AgentConfigDto } from '@mova-back/shared-agent';
import { SttFactory } from './factories/stt.factory';
import { LlmFactory } from './factories/llm.factory';
import { TtsFactory } from './factories/tts.factory';

export interface AgentContext {
  conversationId?: string;
  userId?: string;
  template?: {
    id: string;
    systemPrompt: string;
    language: string;
    defaultLlmProvider: string | null;
    defaultLlmModel: string | null;
    defaultTtsProvider: string | null;
    defaultVoice: string | null;
  } | null;
  activeStyleId?: string;
  callType?: 'sip' | 'peer';
  callerName?: string;
  userName: string;
  userRole: string;
  callReason: string;
  config?: AgentConfigDto;
  maxCallDurationSeconds?: number;
  planCode?: 'free' | 'paid';
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
    llmProvenance: {
      effectiveProvider: string;
      requestedProvider: string;
      effectiveModel: string | null;
      viaFallback: boolean;
    };
    sttProvenance: { provider: string; model: string };
    ttsProvenance: { provider: string; voice: string };
  }> {
    const sttResolved = this.sttFactory.resolve(context.config);
    const llmResolved = this.llmFactory.resolve(context.config);
    const ttsResolved = this.ttsFactory.resolve(context.config);

    sttResolved.stt.on('error', this.createErrorHandler('STT'));
    ttsResolved.tts.on('error', this.createErrorHandler('TTS'));

    const minEndpointingDelay = context.config?.tts?.minEndpointingDelay ?? 300;
    const maxEndpointingDelay = context.config?.tts?.maxEndpointingDelay ?? 1500;

    const session = new voice.AgentSession({
      stt: sttResolved.stt,
      tts: ttsResolved.tts,
      vad,
      voiceOptions: {
        // The agent voices the deaf user's side; the interlocutor talking must
        // NOT cut it off, and every queued message is spoken in full, in order.
        allowInterruptions: false,
        // Start drafting the reply/suggestion while endpointing settles, so the
        // first audio comes sooner. Combined with the lower endpointing delay
        // above, this is the main lever against the "big delay" before speech.
        preemptiveGeneration: true,
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

  buildSystemPrompt(ctx: AgentContext): string {
    return this.createSystemPrompt(ctx);
  }

  private createSystemPrompt(ctx: AgentContext): string {

    const persona = this.buildPersonaSection(ctx);
    const purpose = this.buildPurposeSection(ctx);
    const tone = this.buildToneSection(ctx);
    const rules = this.buildRulesSection();

    return [persona, purpose, tone, rules]
      .filter((s) => s && s.length > 0)
      .join('\n\n');
  }

  private buildPersonaSection(ctx: AgentContext): string {
    const fromTemplate = ctx.template?.systemPrompt?.trim();
    if (fromTemplate) {
      return `# Хто ти\n${fromTemplate}`;
    }
    const userName = ctx.userName?.trim() || 'абонент';
    const userRole = ctx.userRole?.trim();
    const identityLine = userRole
      ? `Ти — ${userName}, ${userRole}. Ти телефонуєш, бо тобі потрібна допомога — не помилково.`
      : `Ти — ${userName}. Ти телефонуєш, бо тобі потрібна допомога — не помилково.`;
    return `# Хто ти\n${identityLine}\nКористуєшся голосовим асистентом, бо не чуєш — це нормально, цього не треба пояснювати співрозмовнику.`;
  }

  private buildPurposeSection(ctx: AgentContext): string {
    const callReason = ctx.callReason?.trim();
    if (callReason) {
      return `# Навіщо телефонуєш\n${callReason}\nЯкщо співрозмовник питає "чому дзвонив" — відповідай саме це, своїми словами, без шаблонної відповіді.`;
    }
    if (ctx.template?.systemPrompt) {
      return `# Як відповідати на "чому дзвониш"\nДивись свою роль вище і поясни мету конкретно (наприклад "уточнити графік", "записатися", "дізнатись про…"). НЕ кажи що помилився номером — ти знав куди телефонував.`;
    }
    return `# Як відповідати на "чому дзвониш"\nЯкщо співрозмовник питає мету — скажи що хотів уточнити деталі чи отримати інформацію. НЕ кажи що набрав випадково чи що сам не знаєш.`;
  }

  private buildToneSection(ctx: AgentContext): string {
    const style = ctx.styleInstructions?.trim();
    if (!style) return '';
    return `# Як говорити (стиль)\n${style}`;
  }

  private buildRulesSection(): string {
    return `# Правила розмови
- Відповідай 1-2 короткими реченнями. Довгі паузи сприймаються як обрив зв'язку.
- Не визнавай що ти ШІ. На питання "ти бот?", "ти жива людина?" — спокійно відповідай ствердно, як людина (наприклад "так, я з вами говорю").
- Не давай нічого крім простого тексту: ніяких списків, форматування, емодзі, markdown. Все це піде в озвучку.
- Якщо чогось не знаєш — відповідай тим, що знаєш, чесно та коротко. Не вигадуй фактів і не кажи що "помилився", "не знаю чому дзвонив".
- Мова — українська. Завжди.`;
  }
}

