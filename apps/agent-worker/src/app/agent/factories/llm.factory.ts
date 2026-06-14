import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llm, inference } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { AgentConfigDto, LlmProviderEnum } from '@mova-back/shared-agent';

import { ProviderRegistry } from '../../providers/provider-registry.service';

export interface ResolvedLlm {
  llm: llm.LLM;
  effectiveProvider: LlmProviderEnum;
  effectiveModel: string | null;
  requestedProvider: LlmProviderEnum;
  viaFallback: boolean;
}

@Injectable()
export class LlmFactory {
  private readonly logger = new Logger(LlmFactory.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registry: ProviderRegistry,
  ) {}

  create(agentConfig?: AgentConfigDto): llm.LLM {
    return this.resolve(agentConfig).llm;
  }

  resolve(agentConfig?: AgentConfigDto): ResolvedLlm {
    const requestedProvider = this.requestedProviderFrom(agentConfig);
    const selection = this.safeSelect(requestedProvider);
    const effectiveProvider = selection.id;
    const viaFallback = effectiveProvider !== requestedProvider;
    if (viaFallback) {
      this.logger.warn(
        `[Factory: LLM] Requested ${requestedProvider} is unhealthy ` +
          `(score=${selection.requestedScore}) — falling back to ${effectiveProvider}.`,
      );
    }
    const requestedModel = viaFallback ? undefined : agentConfig?.llm?.model;
    const effectiveModel = this.resolveModel(effectiveProvider, requestedModel);
    const llm = this.buildPluginFor(effectiveProvider, effectiveModel);
    return { llm, effectiveProvider, effectiveModel, requestedProvider, viaFallback };
  }

  private resolveModel(
    provider: LlmProviderEnum,
    requestedModel: string | undefined,
  ): string {
    switch (provider) {
      case LlmProviderEnum.OPENAI:
        return requestedModel || this.config.get<string>('LLM_MODEL', 'gpt-4.1-nano');
      case LlmProviderEnum.GEMINI: {
        const m = requestedModel || this.config.get<string>('LLM_MODEL', 'google/gemini-2.5-flash-lite');
        return m.startsWith('google/') ? m : `google/${m}`;
      }
      case LlmProviderEnum.ANTHROPIC: {
        const m = requestedModel || this.config.get<string>('LLM_MODEL', 'anthropic/claude-haiku-4-5');
        return m.startsWith('anthropic/') ? m : `anthropic/${m}`;
      }
      case LlmProviderEnum.GROQ: {
        const m = requestedModel || this.config.get<string>('LLM_MODEL', 'groq/llama-3.1-8b-instant');
        return m.startsWith('groq/') ? m : `groq/${m}`;
      }
      default:
        return 'gpt-4.1-nano';
    }
  }

  private requestedProviderFrom(agentConfig?: AgentConfigDto): LlmProviderEnum {
    const providerStr =
      agentConfig?.llm?.provider ||
      this.config.get<string>('LLM_PROVIDER', 'gemini');
    const provider = providerStr.toLowerCase() as LlmProviderEnum;
    if (!Object.values(LlmProviderEnum).includes(provider)) {
      return LlmProviderEnum.GEMINI;
    }
    return provider;
  }

  private safeSelect(prefer: LlmProviderEnum): {
    id: LlmProviderEnum;
    requestedScore?: number;
  } {
    try {
      const snapshot = this.registry.getHealthSnapshot();
      const { provider } = this.registry.selectLlm(prefer);
      return {
        id: provider.id as LlmProviderEnum,
        requestedScore: snapshot[prefer]?.score,
      };
    } catch (err) {
      this.logger.warn(
        `[Factory: LLM] selectLlm failed (${
          err instanceof Error ? err.message : String(err)
        }); using requested provider as-is.`,
      );
      return { id: prefer };
    }
  }

  private buildPluginFor(provider: LlmProviderEnum, model: string): llm.LLM {
    switch (provider) {
      case LlmProviderEnum.OPENAI: {
        this.logger.debug(`🔌 [Factory: LLM] OpenAI native plugin, model=${model}`);
        const instance = new openai.LLM({ model });
        instance.setMaxListeners(0);
        return instance;
      }
      case LlmProviderEnum.GEMINI:
      case LlmProviderEnum.ANTHROPIC:
      case LlmProviderEnum.GROQ:
        return this.viaInferenceGateway(model, '');
      default: {
        this.logger.warn(
          `⚠️ [Factory: LLM] Unknown provider "${provider}", falling back to OpenAI`,
        );
        const fallbackLlm = new openai.LLM({ model: 'gpt-4.1-nano' });
        fallbackLlm.setMaxListeners(0);
        return fallbackLlm;
      }
    }
  }

  private viaInferenceGateway(model: string, prefix: string): llm.LLM {
    const gatewayModel = model.startsWith(prefix) ? model : `${prefix}${model}`;
    this.logger.debug(
      `🔌 [Factory: LLM] LiveKit Inference Gateway, model=${gatewayModel}`,
    );
    const instance = inference.LLM.fromModelString(gatewayModel);
    instance.setMaxListeners(0);
    return instance;
  }
}
