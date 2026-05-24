import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tts } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as google from '@livekit/agents-plugin-google';
import { AgentConfigDto, TtsProviderEnum } from '@mova-back/shared-agent';

import { GoogleCloudTts } from '../providers/google-cloud-tts';

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
    // Precedence: ENV (operator override) > per-call config (user/template
    // preference) > default. ENV wins on purpose — operators need a kill
    // switch when a paid provider (e.g. ElevenLabs) is suddenly broken
    // for everyone (quota exhausted, outage). Without ENV-wins, a stale
    // `template.defaultTtsProvider='elevenlabs'` in the database silently
    // overrides the operator's "switch to google" intent, leaving every
    // call mute even though .env says google.
    //
    // Trade-off: a user who actually paid for premium ElevenLabs voice
    // and switched it in the app loses that choice while ENV is set.
    // For now that's the right side of the fence — silent calls are
    // worse than degraded voice quality. Long-term answer is admin UI
    // for the operator-level override (so leaving ENV unset is OK in
    // steady state).
    const envProvider = this.config.get<string>('TTS_PROVIDER');
    const providerStr = envProvider || agentConfig?.tts?.provider || 'google';
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
        // Gemini-TTS via the Generative Language API (ai.google.dev) using
        // `@livekit/agents-plugin-google`'s `google.beta.TTS`. This path
        // supports plain AI Studio API keys — no service-account / OAuth
        // needed. The cheaper `gemini-2.5-flash-lite-preview-tts` model
        // is ONLY available via Cloud TTS (texttospeech.googleapis.com)
        // which requires a service account + IAM `Vertex AI User` role;
        // we keep that path on ice in `gemini-cloud-tts.ts` for when
        // someone wires up SA auth. For now we default to the non-lite
        // `gemini-2.5-flash-preview-tts` — same voice quality, +~$5/1M
        // chars over lite. Acceptable trade for keeping auth simple.
        const voice =
          agentConfig?.tts?.voice ||
          this.config.get<string>('GEMINI_TTS_VOICE', 'Aoede');
        const model = this.config.get<string>(
          'GEMINI_TTS_MODEL',
          'gemini-2.5-flash-preview-tts',
        );
        // Plugin reads from GOOGLE_API_KEY env if no apiKey arg passed.
        // We accept three env names for the same key so operators using
        // any of the common conventions Just Work:
        //   - GEMINI_API_KEY        (our docs / admin panel name)
        //   - GOOGLE_GENERATIVE_AI_API_KEY (Vercel AI SDK convention,
        //     what's currently in this repo's .env)
        //   - GOOGLE_API_KEY        (plugin's own fallback)
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
        // Google Cloud TTS — primary cheap UA voice. Voice id encodes
        // language + tier + variant, e.g. "uk-UA-Wavenet-A" (female) /
        // "uk-UA-Wavenet-B" (male). Standard tier ("uk-UA-Standard-A") is
        // 4× cheaper still but sounds dated; Wavenet hits the price/
        // quality sweet spot for proxy calls.
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
