import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tts } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as google from '@livekit/agents-plugin-google';
import { AgentConfigDto, TtsProviderEnum } from '@mova-back/shared-agent';

import { GoogleCloudTts } from '../providers/google-cloud-tts';
import { FallbackTts } from '../providers/fallback-tts';

type OpenAITTSOptions = NonNullable<ConstructorParameters<typeof openai.TTS>[0]>;
export type OpenAITTSVoice = OpenAITTSOptions['voice'];

export interface ResolvedTts {
  tts: tts.TTS;
  provider: string;
  voice: string;
}

@Injectable()
export class TtsFactory {
  private readonly logger = new Logger(TtsFactory.name);

  constructor(private readonly config: ConfigService) {}

  create(agentConfig?: AgentConfigDto): tts.TTS {
    return this.resolve(agentConfig).tts;
  }

  resolve(agentConfig?: AgentConfigDto): ResolvedTts {
    const primary = this.resolveOne(agentConfig);
    const fallbackProvider = this.config
      .get<string>('TTS_FALLBACK_PROVIDER')
      ?.toLowerCase() as TtsProviderEnum | undefined;
    if (!fallbackProvider || fallbackProvider === primary.provider) {
      return primary;
    }
    let secondary: ResolvedTts;
    try {
      secondary = this.resolveOne({
        ...(agentConfig ?? {}),
        tts: { provider: fallbackProvider },
      } as AgentConfigDto);
    } catch (err) {
      this.logger.warn(
        `⚠️ [Factory: TTS] TTS_FALLBACK_PROVIDER=${fallbackProvider} failed to resolve: ${(err as Error).message}. Continuing without fallback.`,
      );
      return primary;
    }
    this.logger.log(
      `🔌 [Factory: TTS] Fallback enabled: primary=${primary.provider} → fallback=${secondary.provider}`,
    );
    try {
      const wrapped = new FallbackTts({
        primary: primary.tts,
        fallback: secondary.tts,
      });
      (wrapped as unknown as { setMaxListeners(n: number): void }).setMaxListeners(0);
      return {
        tts: wrapped,
        provider: primary.provider,
        voice: primary.voice,
      };
    } catch (err) {
      this.logger.error(
        `⚠️ [Factory: TTS] FallbackTts wrap failed: ${(err as Error).message}. Using primary only.`,
      );
      return primary;
    }
  }

  private resolveOne(agentConfig?: AgentConfigDto): ResolvedTts {
    const envProvider = this.config.get<string>('TTS_PROVIDER');
    const providerStr = envProvider || agentConfig?.tts?.provider || 'google';
    const provider = providerStr.toLowerCase() as TtsProviderEnum;

    switch (provider) {
      case TtsProviderEnum.ELEVENLABS: {
        this.logger.debug('🔌 [Factory: TTS] Bootstrapping ElevenLabs Engine');

        const voiceId = agentConfig?.tts?.voice || this.config.get<string>('ELEVENLABS_VOICE_ID', 'EXAVITQu4vr4xnSDxMaL');
        const apiKey = this.config.get<string>('ELEVENLABS_API_KEY') || this.config.get<string>('ELEVEN_API_KEY');
        const model = this.config.get<string>('ELEVENLABS_MODEL', 'eleven_flash_v2_5');

        const instance = new elevenlabs.TTS({
          apiKey: apiKey,
          model,
          voiceId: voiceId,
        });

        this.logger.log(
          `🔊 [Factory: TTS] resolved provider=elevenlabs model=${model} voice=${voiceId}`,
        );
        (instance as unknown as { setMaxListeners(n: number): void }).setMaxListeners(0);
        return { tts: instance, provider: 'elevenlabs', voice: voiceId };
      }
      case TtsProviderEnum.OPENAI: {
        const voiceStr = agentConfig?.tts?.voice || this.config.get<string>('TTS_VOICE', 'fable');
        const speed = agentConfig?.tts?.speed ?? (parseFloat(this.config.get<string>('TTS_SPEED', '1.0')) || 1.0);
        // gpt-4o-mini-tts streams (low latency) and speaks Ukrainian far better
        // than the plugin's default tts-1. Overridable via OPENAI_TTS_MODEL.
        const model = this.config.get<string>('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts');
        // gpt-4o-mini-tts is steerable: `instructions` shape the tone/pace so the
        // voice sounds like a real person on a call rather than a flat reader.
        const instructions = this.config.get<string>('OPENAI_TTS_INSTRUCTIONS') || undefined;

        const instance = new openai.TTS({
          model,
          voice: voiceStr as OpenAITTSVoice,
          speed,
          ...(instructions ? { instructions } : {}),
        });
        instance.setMaxListeners(0);
        this.logger.log(
          `🔊 [Factory: TTS] resolved provider=openai model=${model} voice=${voiceStr} speed=${speed}`,
        );
        return { tts: instance, provider: 'openai', voice: voiceStr };
      }
      case TtsProviderEnum.GEMINI: {
        const voice =
          agentConfig?.tts?.voice ||
          this.config.get<string>('GEMINI_TTS_VOICE', 'Aoede');
        const model = this.config.get<string>(
          'GEMINI_TTS_MODEL',
          'gemini-2.5-flash-preview-tts',
        );
        const apiKey =
          this.config.get<string>('GEMINI_API_KEY') ??
          this.config.get<string>('GOOGLE_GENERATIVE_AI_API_KEY') ??
          this.config.get<string>('GOOGLE_API_KEY');
        if (!apiKey) {
          this.logger.warn(
            `⚠️ [Factory: TTS] No Gemini API key set (GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) — falling back to OpenAI for this call.`,
          );
          const fallbackTts = new openai.TTS({ voice: 'fable' as OpenAITTSVoice, speed: 1.0 });
          fallbackTts.setMaxListeners(0);
          return { tts: fallbackTts, provider: 'openai', voice: 'fable' };
        }
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
      case TtsProviderEnum.GOOGLE: {
        const voice =
          agentConfig?.tts?.voice ||
          this.config.get<string>('GOOGLE_TTS_VOICE', 'uk-UA-Wavenet-A');
        const languageCode =
          this.config.get<string>('GOOGLE_TTS_LANGUAGE_CODE', 'uk-UA');
        const apiKey = this.config.get<string>('GOOGLE_TTS_API_KEY');
        if (!apiKey) {
          this.logger.warn(
            `⚠️ [Factory: TTS] GOOGLE_TTS_API_KEY not set, falling back to OpenAI for this call.`,
          );
          const fallbackTts = new openai.TTS({ voice: 'fable' as OpenAITTSVoice, speed: 1.0 });
          fallbackTts.setMaxListeners(0);
          return { tts: fallbackTts, provider: 'openai', voice: 'fable' };
        }
        this.logger.debug(
          `🔌 [Factory: TTS] Google Cloud TTS, voice=${voice}, lang=${languageCode}`,
        );
        const instance = new GoogleCloudTts({
          apiKey,
          languageCode,
          voiceName: voice,
        });
        (instance as unknown as { setMaxListeners(n: number): void }).setMaxListeners(0);
        return { tts: instance, provider: 'google', voice };
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
