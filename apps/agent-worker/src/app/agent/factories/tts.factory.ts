import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tts } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as google from '@livekit/agents-plugin-google';
import { AgentConfigDto, TtsProviderEnum } from '@mova-back/shared-agent';

type OpenAITTSOptions = NonNullable<ConstructorParameters<typeof openai.TTS>[0]>;
export type OpenAITTSVoice = OpenAITTSOptions['voice'];

/**
 * Default Gemini TTS voice + model.
 *
 * Voice: "Kore" — confident female voice, neutral register. Good for the
 * proxy-call use case where we want to sound like a person, not a
 * narrator. Other safe alternatives for UA: "Aoede" (breezier), "Charon"
 * (male, informative).
 *
 * Model: `gemini-2.5-flash-tts` — multilingual, ~$10 / 1M characters
 * vs ElevenLabs at ~$300. The `-lite-preview` variant exists if cost is
 * critical, but its quality drops below the bar we need for UA.
 */
const GEMINI_TTS_DEFAULT_VOICE = 'Kore';
const GEMINI_TTS_DEFAULT_MODEL = 'gemini-2.5-flash-tts';

export interface ResolvedTts {
  tts: tts.TTS;
  /** Effective provider id after env/config resolution. */
  provider: string;
  /** Voice id passed to the underlying engine. */
  voice: string;
}

@Injectable()
export class TtsFactory {
  private readonly logger = new Logger(TtsFactory.name);

  constructor(private readonly config: ConfigService) {}

  /** Back-compat — callers that don't need provenance use this. */
  create(agentConfig?: AgentConfigDto): tts.TTS {
    return this.resolve(agentConfig).tts;
  }

  resolve(agentConfig?: AgentConfigDto): ResolvedTts {
    const providerStr = agentConfig?.tts?.provider || this.config.get<string>('TTS_PROVIDER', 'openai');
    const provider = providerStr.toLowerCase() as TtsProviderEnum;

    switch (provider) {
      case TtsProviderEnum.ELEVENLABS: {
        this.logger.debug('🔌 [Factory: TTS] Bootstrapping ElevenLabs Engine');

        const voiceId = agentConfig?.tts?.voice || this.config.get<string>('ELEVENLABS_VOICE_ID', 'EXAVITQu4vr4xnSDxMaL');
        const apiKey = this.config.get<string>('ELEVENLABS_API_KEY') || this.config.get<string>('ELEVEN_API_KEY');

        const instance = new elevenlabs.TTS({
          apiKey: apiKey,
          model: 'eleven_multilingual_v2',
          voiceId: voiceId,
        });

        // Type casting here is safe as all LiveKit TTS engines inherit from EventEmitter
        (instance as any).setMaxListeners(0);
        return { tts: instance, provider: 'elevenlabs', voice: voiceId };
      }
      case TtsProviderEnum.OPENAI: {
        const voiceStr = agentConfig?.tts?.voice || this.config.get<string>('TTS_VOICE', 'fable');
        const speed = agentConfig?.tts?.speed ?? (parseFloat(this.config.get<string>('TTS_SPEED', '1.0')) || 1.0);

        const instance = new openai.TTS({ voice: voiceStr as OpenAITTSVoice, speed });
        instance.setMaxListeners(0);
        return { tts: instance, provider: 'openai', voice: voiceStr };
      }
      case TtsProviderEnum.GEMINI: {
        // Multilingual generative TTS via the same key as the LLM. ~$10
        // per 1M chars vs ElevenLabs' $300, with respectable UA prosody
        // because Gemini is heavily multilingual-trained.
        const voice =
          agentConfig?.tts?.voice ||
          this.config.get<string>('GEMINI_TTS_VOICE', GEMINI_TTS_DEFAULT_VOICE);
        const model = this.config.get<string>(
          'GEMINI_TTS_MODEL',
          GEMINI_TTS_DEFAULT_MODEL,
        );
        // apiKey is optional in the plugin constructor — when omitted it
        // reads GOOGLE_API_KEY from process.env. We pass it explicitly
        // from GEMINI_API_KEY so the admin-panel-managed override (which
        // hydrates GEMINI_API_KEY into process.env on boot) is picked up
        // without forcing the operator to also set GOOGLE_API_KEY.
        const apiKey =
          this.config.get<string>('GEMINI_API_KEY') ??
          this.config.get<string>('GOOGLE_API_KEY');
        this.logger.debug(
          `🔌 [Factory: TTS] Gemini TTS, model=${model}, voice=${voice}`,
        );
        const instance = new google.beta.TTS({
          model,
          voiceName: voice,
          apiKey,
        });
        (instance as unknown as { setMaxListeners(n: number): void }).setMaxListeners(0);
        return { tts: instance, provider: 'gemini', voice };
      }
      default: {
        this.logger.warn(`⚠️ [Factory: TTS] Unknown provider "${provider}", falling back to OpenAI`);
        const fallbackTts = new openai.TTS({ voice: 'fable' as OpenAITTSVoice, speed: 1.0 });
        fallbackTts.setMaxListeners(0);
        return { tts: fallbackTts, provider: 'openai', voice: 'fable' };
      }
    }
  }
}
