import { LlmProviderEnum, SttProviderEnum, TtsProviderEnum } from './agent-models.enum';

export interface SttConfigDto {
  provider?: SttProviderEnum;
  model?: string;
  language?: string;
}

export interface LlmConfigDto {
  provider?: LlmProviderEnum;
  model?: string;
}

export interface TtsConfigDto {
  provider?: TtsProviderEnum;
  voice?: string;
  // Per-call model override (e.g. ElevenLabs flash vs multilingual for the
  // realistic vs ultra voice tiers). Falls back to the provider's env default.
  model?: string;
  speed?: number;
  minEndpointingDelay?: number;
  maxEndpointingDelay?: number;
}

export interface AgentConfigDto {
  stt?: SttConfigDto;
  llm?: LlmConfigDto;
  tts?: TtsConfigDto;
}
