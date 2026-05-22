import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llm, inference } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { AgentConfigDto, LlmProviderEnum } from '@mova-back/shared-agent';

import { ProviderRegistry } from '../../providers/provider-registry.service';

/**
 * Result of resolving the in-call LLM. Includes provenance so the caller
 * can emit a `provider.failure` (recoverable) event when the user's
 * requested provider was unhealthy and we transparently substituted a
 * healthier one — the mobile UI can then show a "degraded mode" banner
 * from the very first turn instead of leaving the user wondering why
 * their picked model isn't being used.
 */
export interface ResolvedLlm {
  llm: llm.LLM;
  /** Provider id we ended up using (after health-based selection). */
  effectiveProvider: LlmProviderEnum;
  /** Provider id requested by the caller (template / per-call config / env). */
  requestedProvider: LlmProviderEnum;
  /** True when registry redirected us away from the requested provider. */
  viaFallback: boolean;
}

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

  constructor(
    private readonly config: ConfigService,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * Resolve and instantiate the in-call LLM, routing through the registry's
   * health snapshot. Flow:
   *   1. Compute the *requested* provider from config / env / hardcoded
   *      default (the same precedence as before).
   *   2. Ask the registry for the actual provider to use given that
   *      preference. Registry returns the requested one if healthy,
   *      otherwise the next best in the fallback order.
   *   3. Instantiate the LiveKit plugin for the effective provider. If
   *      the user requested a specific model AND we ended up on the
   *      same provider, honour it; otherwise use that provider's default
   *      so we don't try `claude-3-sonnet` on the OpenAI plugin.
   *
   * `create()` retained for callers that don't care about provenance.
   */
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
    // Honour user's model only when we stayed on the user's provider.
    // Cross-provider model strings are nonsense (e.g. "gpt-4o" on Anthropic).
    const requestedModel = viaFallback ? undefined : agentConfig?.llm?.model;
    const llm = this.buildPluginFor(effectiveProvider, requestedModel);
    return { llm, effectiveProvider, requestedProvider, viaFallback };
  }

  private requestedProviderFrom(agentConfig?: AgentConfigDto): LlmProviderEnum {
    const providerStr =
      agentConfig?.llm?.provider ||
      this.config.get<string>('LLM_PROVIDER', 'openai');
    const provider = providerStr.toLowerCase() as LlmProviderEnum;
    // Unknown enum value → coerce to OpenAI (hard default). buildPluginFor
    // will also defend, but normalising here keeps logging readable.
    if (!Object.values(LlmProviderEnum).includes(provider)) {
      return LlmProviderEnum.OPENAI;
    }
    return provider;
  }

  /** Wrap registry.selectLlm so a missing/empty registry doesn't crash the
   *  call — we just degrade to "use the requested provider as-is". */
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

  private buildPluginFor(
    provider: LlmProviderEnum,
    requestedModel: string | undefined,
  ): llm.LLM {
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
