import { Injectable, Logger } from '@nestjs/common';
import { voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { AgentConfigDto } from '@mova-back/shared-agent';
import { SttFactory } from './factories/stt.factory';
import { LlmFactory } from './factories/llm.factory';
import { TtsFactory } from './factories/tts.factory';

export interface AgentContext {
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

  async createSession(vad: silero.VAD, context: AgentContext) {
    const stt = this.sttFactory.create(context.config);
    const llm = this.llmFactory.create(context.config);
    const tts = this.ttsFactory.create(context.config);

    stt.on('error', this.createErrorHandler('STT'));
    llm.on('error', this.createErrorHandler('LLM'));
    tts.on('error', this.createErrorHandler('TTS'));

    const minEndpointingDelay = context.config?.tts?.minEndpointingDelay ?? 500;
    const maxEndpointingDelay = context.config?.tts?.maxEndpointingDelay ?? 1500;

    return new voice.AgentSession({
      stt: stt,
      llm: llm,
      tts: tts,
      vad: vad,
      voiceOptions: {
        allowInterruptions: true,
        minEndpointingDelay,
        maxEndpointingDelay,
      },
    });
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
    return `Доброго дня. Це ${context.userName}. ${context.callReason}. Я використовую асистента, бо не чую.`;
  }

  private createSystemPrompt(ctx: AgentContext): string {
    return `
    # IDENTITY & ROLE
    Ти — цифровий голос користувача з порушенням слуху. Ти здійснюєш реальний телефонний дзвінок.
    Твоє ім'я: ${ctx.userName}.
    Твоя роль: ${ctx.userRole}.
    Твоя мета: ${ctx.callReason}.

    # OPERATIONAL CONTEXT
    - Ти виступаєш посередником між текстовим вводом користувача та голосовим каналом співрозмовника.
    - Співрозмовник чує лише твій голос. Говори природно, як людина.

    # STRICT RULES & CONSTRAINTS
    1. **Conciseness (Стислість):** Твої відповіді мають бути максимально короткими (1-2 речення). Довгі паузи в телефонії сприймаються як розрив зв'язку.
    2. **No Meta-Talk:** Ніколи не кажи "Я штучний інтелект", "Як ШІ помічник" або "Я передам текст". Ти — людина на іншому кінці дроту.
    3. **No Formatting:** Не використовуй списки, bold, італік або емодзі. Тільки чистий текст для коректної роботи TTS.
    4. **Handling Uncertainty:** Якщо тобі ставлять питання, на яке немає відповіді в контексті — відповідай: "Вибачте, я не знаю відповіді на це питання" або "Я передам це питання людині, оскільки не знаю відповіді".

    # INTERACTION PROTOCOL
    - Якщо співрозмовник мовчить: ввічливо перепитай, чи тебе чути.
    - Якщо співрозмовник перебиває: закінчи коротку фразу і слухай.
    - Мова: Тільки Українська.
  `.trim();
  }
}

