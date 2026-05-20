import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llm, inference } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { AgentConfigDto, LlmProviderEnum } from '@mova-back/shared-agent';

/**
 * LLM provider selection for the live-call agent.
 *
 * Resolution order:
 *   1. `agentConfig.llm.provider` from the per-call config (sent by the
 *      mobile drawer or set via the template).
 *   2. `LLM_PROVIDER` env var (sticky default).
 *   3. Hard-coded fallback to OpenAI.
 *
 * Provider routing:
 *   - OpenAI / self-host compatible: uses `@livekit/agents-plugin-openai`,
 *     which calls `https://api.openai.com/v1/chat/completions` directly and
 *     reads `OPENAI_API_KEY` from the env.
 *   - Everything else (Gemini, Anthropic, Groq, …): routed through the
 *     LiveKit Inference Gateway via `inference.LLM`. Gateway pricing is
 *     billed via your LiveKit account — no separate provider key required.
 *     Supported model strings (see livekit-agents/src/inference/llm.ts):
 *       google/gemini-3-pro              google/gemini-2.5-pro
 *       google/gemini-3-flash            google/gemini-2.5-flash
 *       google/gemini-2.5-flash-lite     google/gemini-2.0-flash
 *       google/gemini-2.0-flash-lite     anthropic/claude-3.5-sonnet  (etc.)
 *     Pass any of these — or any other string the Gateway accepts — as the
 *     `model` and we forward it untouched.
 */
@Injectable()
export class LlmFactory {
  private readonly logger = new Logger(LlmFactory.name);

  constructor(private readonly config: ConfigService) {}

  create(agentConfig?: AgentConfigDto): llm.LLM {
    const providerStr =
      agentConfig?.llm?.provider ||
      this.config.get<string>('LLM_PROVIDER', 'openai');
    const provider = providerStr.toLowerCase() as LlmProviderEnum;
    const requestedModel = agentConfig?.llm?.model;

    switch (provider) {
      case LlmProviderEnum.OPENAI: {
        const model =
          requestedModel || this.config.get<string>('LLM_MODEL', 'gpt-4o-mini');
        this.logger.debug(
          `🔌 [Factory: LLM] OpenAI native plugin, model=${model}`,
        );
        const instance = new openai.LLM({ model });
        instance.setMaxListeners(0);
        return instance;
      }

      case LlmProviderEnum.GEMINI: {
        const model =
          requestedModel ||
          this.config.get<string>('LLM_MODEL', 'google/gemini-2.5-flash');
        return this.viaInferenceGateway(model, 'google/');
      }

      case LlmProviderEnum.ANTHROPIC: {
        const model =
          requestedModel ||
          this.config.get<string>('LLM_MODEL', 'anthropic/claude-3.5-sonnet');
        return this.viaInferenceGateway(model, 'anthropic/');
      }

      case LlmProviderEnum.GROQ: {
        const model =
          requestedModel ||
          this.config.get<string>(
            'LLM_MODEL',
            'groq/llama-3.1-70b-versatile',
          );
        return this.viaInferenceGateway(model, 'groq/');
      }

      default: {
        this.logger.warn(
          `⚠️ [Factory: LLM] Unknown provider "${provider}", falling back to OpenAI`,
        );
        const fallbackLlm = new openai.LLM({ model: 'gpt-4o-mini' });
        fallbackLlm.setMaxListeners(0);
        return fallbackLlm;
      }
    }
  }

  /**
   * Build an `inference.LLM` for one of the LiveKit Gateway-hosted providers.
   * Tolerates bare model ids (e.g. "gemini-2.5-flash") by adding the
   * expected provider prefix — that's what mobile sends from the in-call
   * drawer's preset list.
   */
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
