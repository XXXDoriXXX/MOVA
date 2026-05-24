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
  /** Effective provider id after env/config resolution. */
  provider: string;
  /** Provider-specific model id (e.g. "nova-3" for Deepgram). */
  model: string;
}

/**
 * STT factory. Cold-swap fallback architecture:
 *
 * Unlike TTS (utterance-at-a-time → easy mid-stream swap via
 * FallbackTts), STT is a continuous duplex stream — audio frames in,
 * transcripts out. A mid-call provider swap means tearing down the
 * audio pipeline AND losing whatever was already pushed but not yet
 * acknowledged. That's a real degradation, not transparent.
 *
 * So STT fallback here is **cold-swap on session creation**:
 *   - resolve() tries the primary provider first.
 *   - If primary provider construction throws (missing API key,
 *     plugin import error), AND `STT_FALLBACK_PROVIDER` env is set
 *     to a different provider, we resolve that instead.
 *   - Logged at WARN so dashboards alert on the fallback path.
 *
 * To add a second provider (e.g. Whisper, Google Speech-to-Text):
 *   1. Add the entry to `SttProviderEnum` in libs/shared-agent.
 *   2. Add a `case` in `resolveOne()` constructing your stt.STT subclass.
 *   3. Set `STT_FALLBACK_PROVIDER=<your-provider>` in env.
 *   4. Operator runbook update if the provider has its own setup
 *      (API key, regional endpoint, etc).
 *
 * TRUE mid-call STT failover (audio-mid-stream re-anchor) is parked
 * out-of-scope — needs SDK-level audio buffer management that
 * LiveKit Agents JS doesn't expose. See RUNBOOK "STT outage"
 * section for the manual mitigation: flip STT_PROVIDER + restart
 * agent-worker container; in-flight calls get AGENT_LOST as
 * expected, mobile auto-reconnects with the new provider.
 */
@Injectable()
export class SttFactory {
  private readonly logger = new Logger(SttFactory.name);

  constructor(private readonly config: ConfigService) {}

  /** Back-compat — callers that don't need provenance use this. */
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
      // Cold-swap path: primary construction failed (missing key,
      // plugin error, etc). Try the secondary if one is configured
      // AND it's different from the primary.
      const fallback = (
        this.config.get<string>('STT_FALLBACK_PROVIDER') ?? ''
      ).toLowerCase() as SttProviderEnum;
      if (!fallback || fallback === primary) {
        // No fallback path available — re-throw so AgentFactory's
        // createSession surfaces it via call.ended.
        throw err;
      }
      this.logger.warn(
        `⚠️ [Factory: STT] Primary "${primary}" failed (${(err as Error).message}) — cold-swap to fallback "${fallback}".`,
      );
      return this.resolveOne(fallback, agentConfig);
    }
  }

  /** Inner resolver — switches on a single provider enum without
   *  fallback logic. Called once or twice by `resolve()` depending
   *  on whether the primary throws. */
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
        // Whisper batched-mode STT — scaffold per Phase 12.2.
        // Activates when `STT_PROVIDER=openai` OR
        // `STT_FALLBACK_PROVIDER=openai` (cold-swap path above).
        // Requires OPENAI_API_KEY env. See WhisperStt header for the
        // latency / cost trade-off vs Deepgram.
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
