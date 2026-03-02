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
  speed?: number;
  minEndpointingDelay?: number;
  maxEndpointingDelay?: number;
}

export interface AgentConfigDto {
  stt?: SttConfigDto;
  llm?: LlmConfigDto;
  tts?: TtsConfigDto;
}
