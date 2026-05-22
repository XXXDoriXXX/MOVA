import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tts } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { AgentConfigDto, TtsProviderEnum } from '@mova-back/shared-agent';

type OpenAITTSOptions = NonNullable<ConstructorParameters<typeof openai.TTS>[0]>;
export type OpenAITTSVoice = OpenAITTSOptions['voice'];

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
      default: {
        this.logger.warn(`⚠️ [Factory: TTS] Unknown provider "${provider}", falling back to OpenAI`);
        const fallbackTts = new openai.TTS({ voice: 'fable' as OpenAITTSVoice, speed: 1.0 });
        fallbackTts.setMaxListeners(0);
        return { tts: fallbackTts, provider: 'openai', voice: 'fable' };
      }
    }
  }
}
