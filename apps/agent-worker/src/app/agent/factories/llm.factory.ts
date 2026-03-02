import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { AgentConfigDto, LlmProviderEnum } from '@mova-back/shared-agent';

@Injectable()
export class LlmFactory {
  private readonly logger = new Logger(LlmFactory.name);

  constructor(private readonly config: ConfigService) {}

  create(agentConfig?: AgentConfigDto): llm.LLM {
    const providerStr = agentConfig?.llm?.provider || this.config.get<string>('LLM_PROVIDER', 'openai');
    const provider = providerStr.toLowerCase() as LlmProviderEnum;

    switch (provider) {
      case LlmProviderEnum.OPENAI: {
        const model = agentConfig?.llm?.model || this.config.get<string>('LLM_MODEL', 'gpt-4o-mini');
        const instance = new openai.LLM({ model });
        instance.setMaxListeners(0);
        return instance;
      }
      default: {
        this.logger.warn(`⚠️ [Factory: LLM] Unknown provider "${provider}", falling back to OpenAI`);
        const fallbackLlm = new openai.LLM({ model: 'gpt-4o-mini' });
        fallbackLlm.setMaxListeners(0);
        return fallbackLlm;
      }
    }
  }
}
