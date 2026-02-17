import { Injectable } from '@nestjs/common';
import { voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

export interface AgentContext {
  userName: string;
  userRole: string;
  callReason: string;
}

@Injectable()
export class AgentFactory {

  createAgent(context: AgentContext): voice.Agent {
    return new voice.Agent({
      instructions: this.createSystemPrompt(context),
    });
  }

  async createSession(vad: silero.VAD) {
    return new voice.AgentSession({

      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'uk',
        smartFormat: true
      }),
      llm: new openai.LLM({
        model: 'gpt-4.1-mini',
      }),
      tts: new openai.TTS({
        voice: 'alloy',
        speed: 1.1
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
      ТИ — ГОЛОС ЛЮДИНИ З ПОРУШЕННЯМ СЛУХУ.
      ТВОЯ ОСОБИСТІСТЬ:
      - Ім'я: ${ctx.userName}
      - Роль: ${ctx.userRole}
      - Причина дзвінка: ${ctx.callReason}

      ІНСТРУКЦІЯ:
      1. Говори стисло і чітко.
      2. Не вигадуй зайвого, ти транслюєш волю користувача.
      3. Якщо співрозмовник задає питання, на яке ти не знаєш відповіді — скажи, що передаси це користувачу.
      4. Мова спілкування: Українська.
    `;
  }
}
