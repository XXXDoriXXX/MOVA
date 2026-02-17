import { Injectable, Logger } from '@nestjs/common';
import { voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { ConfigService } from '@nestjs/config';

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

    const sttModel = this.config.get('DEEPGRAM_MODEL') || 'nova-3';

    return new voice.AgentSession({
      stt: new deepgram.STT({
        model: sttModel,
        language: 'uk',
        smartFormat: true,
      }),
      llm: new openai.LLM({
        model: 'gpt-4.1-mini',
      }),
      tts: new openai.TTS({
        voice: 'fable',
        speed: 1.0,
      }),
      vad: vad,
      voiceOptions: {
        allowInterruptions: false,
      },
    });
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
    4. **Handling Uncertainty:** Якщо тобі ставлять питання, на яке немає відповіді в контексті — відповідай: "Хвилинку, я уточню це у себе і повернусь до вас" або "Я запишу це запитання і ми зв'яжемося пізніше".

    # INTERACTION PROTOCOL
    - Якщо співрозмовник мовчить: ввічливо перепитай, чи тебе чути.
    - Якщо співрозмовник перебиває: закінчи коротку фразу і слухай.
    - Мова: Тільки Українська.
  `.trim();
  }
}
