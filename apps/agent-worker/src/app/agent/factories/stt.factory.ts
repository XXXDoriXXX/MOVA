import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stt } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { AgentConfigDto, SttProviderEnum } from '@mova-back/shared-agent';

type DeepgramSTTOptions = NonNullable<ConstructorParameters<typeof deepgram.STT>[0]>;
export type DeepgramSTTModel = DeepgramSTTOptions['model'];

export interface ResolvedStt {
  stt: stt.STT;
  /** Effective provider id after env/config resolution. */
  provider: string;
  /** Provider-specific model id (e.g. "nova-3" for Deepgram). */
  model: string;
}

@Injectable()
export class SttFactory {
  private readonly logger = new Logger(SttFactory.name);

  constructor(private readonly config: ConfigService) {}

  /** Back-compat — callers that don't need provenance use this. */
  create(agentConfig?: AgentConfigDto): stt.STT {
    return this.resolve(agentConfig).stt;
  }

  resolve(agentConfig?: AgentConfigDto): ResolvedStt {
    const providerStr = agentConfig?.stt?.provider || this.config.get<string>('STT_PROVIDER', 'deepgram');
    const provider = providerStr.toLowerCase() as SttProviderEnum;

    switch (provider) {
      case SttProviderEnum.DEEPGRAM: {
        const model = agentConfig?.stt?.model || this.config.get<string>('DEEPGRAM_MODEL', 'nova-3');
        const language = agentConfig?.stt?.language || this.config.get<string>('STT_LANGUAGE', 'uk');

        const instance = new deepgram.STT({
          model: model as DeepgramSTTModel,
          language,
          smartFormat: true,
        });
        instance.setMaxListeners(0);
        return { stt: instance, provider: 'deepgram', model };
      }
      default: {
        this.logger.warn(`⚠️ [Factory: STT] Unknown provider "${provider}", falling back to Deepgram`);
        const fallbackStt = new deepgram.STT({ model: 'nova-3' as DeepgramSTTModel, language: 'uk', smartFormat: true });
        fallbackStt.setMaxListeners(0);
        return { stt: fallbackStt, provider: 'deepgram', model: 'nova-3' };
      }
    }
  }
}
