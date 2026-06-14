import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

export interface VoiceOption {
  id: string;
  provider: 'openai' | 'gemini' | 'google' | 'elevenlabs';
  label: string;
  language: 'uk-UA' | 'en-US' | 'multi';
  gender?: 'female' | 'male' | 'neutral';
}

const VOICES: VoiceOption[] = [
  { id: 'uk-UA-Wavenet-A', provider: 'google', label: 'Wavenet A · UA',  language: 'uk-UA', gender: 'female' },
  { id: 'uk-UA-Wavenet-B', provider: 'google', label: 'Wavenet B · UA',  language: 'uk-UA', gender: 'male' },
  { id: 'uk-UA-Wavenet-C', provider: 'google', label: 'Wavenet C · UA',  language: 'uk-UA', gender: 'female' },
  { id: 'uk-UA-Wavenet-D', provider: 'google', label: 'Wavenet D · UA',  language: 'uk-UA', gender: 'male' },
  { id: 'uk-UA-Standard-A', provider: 'google', label: 'Standard A · UA (cheap)', language: 'uk-UA', gender: 'female' },
  { id: 'uk-UA-Standard-B', provider: 'google', label: 'Standard B · UA (cheap)', language: 'uk-UA', gender: 'male' },

  { id: 'Aoede',  provider: 'gemini', label: 'Aoede (warm)',         language: 'multi', gender: 'female' },
  { id: 'Kore',   provider: 'gemini', label: 'Kore (neutral)',       language: 'multi', gender: 'female' },
  { id: 'Charon', provider: 'gemini', label: 'Charon (informative)', language: 'multi', gender: 'male' },
  { id: 'Puck',   provider: 'gemini', label: 'Puck (playful)',       language: 'multi', gender: 'neutral' },
  { id: 'Fenrir', provider: 'gemini', label: 'Fenrir (grounded)',    language: 'multi', gender: 'male' },

  { id: 'EXAVITQu4vr4xnSDxMaL', provider: 'elevenlabs', label: 'Sarah · multilingual',    language: 'multi', gender: 'female' },
  { id: 'pNInz6obpgDQGcFmaJgB', provider: 'elevenlabs', label: 'Adam · multilingual',     language: 'multi', gender: 'male' },
  { id: 'XB0fDUnXU5powFXDhCwa', provider: 'elevenlabs', label: 'Charlotte · multilingual', language: 'multi', gender: 'female' },

  { id: 'alloy',   provider: 'openai', label: 'Alloy',   language: 'en-US', gender: 'neutral' },
  { id: 'echo',    provider: 'openai', label: 'Echo',    language: 'en-US', gender: 'male' },
  { id: 'fable',   provider: 'openai', label: 'Fable',   language: 'en-US', gender: 'male' },
  { id: 'onyx',    provider: 'openai', label: 'Onyx',    language: 'en-US', gender: 'male' },
  { id: 'nova',    provider: 'openai', label: 'Nova',    language: 'en-US', gender: 'female' },
  { id: 'shimmer', provider: 'openai', label: 'Shimmer', language: 'en-US', gender: 'female' },
];

@ApiTags('voices')
@ApiBearerAuth()
@Controller('voices')
export class VoicesController {
  @Get()
  @ApiOperation({
    summary: 'List TTS voices the mobile picker can offer for the user profile.',
  })
  list(): { items: VoiceOption[] } {
    return { items: VOICES };
  }
}
