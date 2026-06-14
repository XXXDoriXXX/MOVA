import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stt } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { AgentConfigDto, SttProviderEnum } from '@mova-back/shared-agent';

import { WhisperStt } from '../providers/whisper-stt';

type DeepgramSTTOptions = NonNullable<ConstructorParameters<typeof deepgram.STT>[0]>;
export type DeepgramSTTModel = DeepgramSTTOptions['model'];

export interface ResolvedStt {
  stt: stt.STT;
  provider: string;
  model: string;
}

@Injectable()
export class SttFactory {
  private readonly logger = new Logger(SttFactory.name);

  constructor(private readonly config: ConfigService) {}

  create(agentConfig?: AgentConfigDto): stt.STT {
    return this.resolve(agentConfig).stt;
  }

  resolve(agentConfig?: AgentConfigDto): ResolvedStt {
    const providerStr =
      agentConfig?.stt?.provider ||
      this.config.get<string>('STT_PROVIDER', 'deepgram');
    const primary = providerStr.toLowerCase() as SttProviderEnum;

    try {
      return this.resolveOne(primary, agentConfig);
    } catch (err) {
      const fallback = (
        this.config.get<string>('STT_FALLBACK_PROVIDER') ?? ''
      ).toLowerCase() as SttProviderEnum;
      if (!fallback || fallback === primary) {
        throw err;
      }
      this.logger.warn(
        `⚠️ [Factory: STT] Primary "${primary}" failed (${(err as Error).message}) — cold-swap to fallback "${fallback}".`,
      );
      return this.resolveOne(fallback, agentConfig);
    }
  }

  private resolveOne(
    provider: SttProviderEnum,
    agentConfig?: AgentConfigDto,
  ): ResolvedStt {
    switch (provider) {
      case SttProviderEnum.DEEPGRAM: {
        const model =
          agentConfig?.stt?.model ||
          this.config.get<string>('DEEPGRAM_MODEL', 'nova-3');
        const language =
          agentConfig?.stt?.language ||
          this.config.get<string>('STT_LANGUAGE', 'uk');

        const instance = new deepgram.STT({
          model: model as DeepgramSTTModel,
          language,
          smartFormat: true,
        });
        instance.setMaxListeners(0);
        return { stt: instance, provider: 'deepgram', model };
      }
      case SttProviderEnum.OPENAI: {
        const apiKey =
          this.config.get<string>('OPENAI_API_KEY') ?? undefined;
        if (!apiKey) {
          throw new Error(
            'WhisperStt requires OPENAI_API_KEY. Set it in env or use a different STT_PROVIDER.',
          );
        }
        const model =
          agentConfig?.stt?.model ||
          this.config.get<string>('WHISPER_MODEL', 'whisper-1');
        const language =
          agentConfig?.stt?.language ||
          this.config.get<string>('STT_LANGUAGE', 'uk');
        const instance = new WhisperStt({ apiKey, model, language });
        (instance as unknown as { setMaxListeners(n: number): void }).setMaxListeners(0);
        return { stt: instance, provider: 'openai', model };
      }
      default: {
        this.logger.warn(
          `⚠️ [Factory: STT] Unknown provider "${provider}", falling back to Deepgram defaults`,
        );
        const fallbackStt = new deepgram.STT({
          model: 'nova-3' as DeepgramSTTModel,
          language: 'uk',
          smartFormat: true,
        });
        fallbackStt.setMaxListeners(0);
        return { stt: fallbackStt, provider: 'deepgram', model: 'nova-3' };
      }
    }
  }
}
