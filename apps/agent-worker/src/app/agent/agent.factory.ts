import { Injectable, Logger } from '@nestjs/common';
import { voice, stt, llm, tts } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------
// 🛡️ Future-Proof Type Extraction via Utility Types
// We dynamically infer the allowed strings for 'model' and 'voice'
// directly from the constructors of the plugins' public API.
// This prevents compilation breaks if LiveKit restructures its internal /dist folders.
// ---------------------------------------------------------
type DeepgramSTTOptions = NonNullable<ConstructorParameters<typeof deepgram.STT>[0]>;
export type DeepgramSTTModel = DeepgramSTTOptions['model'];

type OpenAITTSOptions = NonNullable<ConstructorParameters<typeof openai.TTS>[0]>;
export type OpenAITTSVoice = OpenAITTSOptions['voice'];

export interface AgentContext {
  userName: string;
  userRole: string;
  callReason: string;
}

@Injectable()
export class AgentFactory {
  private readonly logger = new Logger(AgentFactory.name);

  constructor(private readonly config: ConfigService) {}

  createAgent(context: AgentContext): voice.Agent {
    return new voice.Agent({
      instructions: this.createSystemPrompt(context),
    });
  }

  async createSession(vad: silero.VAD) {
    const stt = this.createSTT();
    const llm = this.createLLM();
    const tts = this.createTTS();

    stt.on('error', this.createErrorHandler('STT'));
    llm.on('error', this.createErrorHandler('LLM'));
    tts.on('error', this.createErrorHandler('TTS'));

    return new voice.AgentSession({
      stt: stt,
      llm: llm,
      tts: tts,
      vad: vad,
      voiceOptions: {
        allowInterruptions: true,
        minEndpointingDelay: 500,
        maxEndpointingDelay: 1500,
      },
    });
  }

  // ---- Factory Methods for Providers ----

  private createSTT(): stt.STT {
    const provider = this.config.get<string>('STT_PROVIDER', 'deepgram').toLowerCase();

    switch (provider) {
      case 'deepgram': {
        const model = this.config.get<string>('DEEPGRAM_MODEL', 'nova-3') as DeepgramSTTModel;
        const language = this.config.get<string>('STT_LANGUAGE', 'uk');
        const stt = new deepgram.STT({ model, language, smartFormat: true });
        stt.setMaxListeners(0);
        return stt;
      }
      default: {
        this.logger.warn(`⚠️ [Factory: STT] Unknown provider "${provider}", falling back to Deepgram`);
        const fallbackStt = new deepgram.STT({ model: 'nova-3' as DeepgramSTTModel, language: 'uk', smartFormat: true });
        fallbackStt.setMaxListeners(0);
        return fallbackStt;
      }
    }
  }

  private createLLM(): llm.LLM {
    const provider = this.config.get<string>('LLM_PROVIDER', 'openai').toLowerCase();

    switch (provider) {
      case 'openai': {
        const model = this.config.get<string>('LLM_MODEL', 'gpt-4o-mini');
        const llm = new openai.LLM({ model });
        llm.setMaxListeners(0);
        return llm;
      }
      default: {
        this.logger.warn(`⚠️ [Factory: LLM] Unknown provider "${provider}", falling back to OpenAI`);
        const fallbackLlm = new openai.LLM({ model: 'gpt-4o-mini' });
        fallbackLlm.setMaxListeners(0);
        return fallbackLlm;
      }
    }
  }

  private createTTS(): tts.TTS {
    const provider = this.config.get<string>('TTS_PROVIDER', 'openai').toLowerCase();

    switch (provider) {
      case 'elevenlabs': {
        this.logger.debug('🔌 [Factory: TTS] Bootstrapping ElevenLabs Engine');

        // Витягуємо Voice ID з конфігу.
        const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID', 'EXAVITQu4vr4xnSDxMaL');
        const apiKey = this.config.get<string>('ELEVENLABS_API_KEY') || this.config.get<string>('ELEVEN_API_KEY');

        const tts = new elevenlabs.TTS({
          apiKey: apiKey,
          // Обов'язково v2 для багатомовності (включаючи ідеальну українську)
          model: 'eleven_multilingual_v2',
          voiceId: voiceId,
        });

        // Type casting here is safe as all LiveKit TTS engines inherit from EventEmitter
        (tts as any).setMaxListeners(0);
        return tts;
      }
      case 'openai': {
        const voiceStr = this.config.get<string>('TTS_VOICE', 'fable') as OpenAITTSVoice;
        const speed = parseFloat(this.config.get<string>('TTS_SPEED', '1.0')) || 1.0;
        const tts = new openai.TTS({ voice: voiceStr, speed });
        tts.setMaxListeners(0);
        return tts;
      }
      // Future placeholder examples:
      // case 'elevenlabs':
      //   return new elevenlabs.TTS({...});
      default: {
        this.logger.warn(`⚠️ [Factory: TTS] Unknown provider "${provider}", falling back to OpenAI`);
        const fallbackTts = new openai.TTS({ voice: 'fable' as OpenAITTSVoice, speed: 1.0 });
        fallbackTts.setMaxListeners(0);
        return fallbackTts;
      }
    }
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
