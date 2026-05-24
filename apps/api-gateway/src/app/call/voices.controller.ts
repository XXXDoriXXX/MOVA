import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Curated TTS-voice catalogue the mobile in-call settings drawer can
 * render in the voice picker. Static on purpose — the underlying SDKs
 * each have their own (often-changing) catalogues, and we want a
 * quality-vetted UA-first subset rather than dumping every regional
 * variant on the user.
 *
 * The drawer used to ship a hard-coded list of OpenAI voices, which
 * silently became wrong once a user switched their preferredTtsProvider
 * to Gemini or Google Cloud TTS — picker showed `alloy/echo/fable…` but
 * saving them on a Google profile would either error or silently fall
 * back to the wrong default. Reading this endpoint and filtering by
 * the user's current `preferredTtsProvider` keeps the picker honest.
 *
 * Save path is unchanged — `PATCH /v1/auth/me { preferredVoice }`.
 * Resolution happens server-side in `call.service.initiateCall`'s
 * precedence chain, so the picked voice takes effect on the very next
 * dial without any further protocol work.
 *
 * Curating policy:
 *   1. Wavenet > Standard for Google (price/quality sweet spot).
 *   2. Gemini voices skip the strong-character ones (Charon-ish heavy,
 *      Schedar-mythological-noisy) — proxy-call voice should sound
 *      like a person, not a narrator.
 *   3. ElevenLabs entries are the public `eleven_multilingual_v2`
 *      voices that handle UA pronunciation well in our smoke tests.
 *   4. OpenAI listed because the provider is still wired and a user
 *      may consciously prefer the cheap-and-fast English variant for
 *      English-language calls.
 */
export interface VoiceOption {
  /** Wire id the user saves via PATCH /v1/auth/me's `preferredVoice`. */
  id: string;
  /** TTS provider this voice belongs to — must match `preferredTtsProvider`. */
  provider: 'openai' | 'gemini' | 'google' | 'elevenlabs';
  /** Human label rendered in the picker. */
  label: string;
  /** BCP-47 best-fit language; `multi` for multilingual voices. */
  language: 'uk-UA' | 'en-US' | 'multi';
  /** Optional gender hint so the UI can render an icon. */
  gender?: 'female' | 'male' | 'neutral';
}

const VOICES: VoiceOption[] = [
  // Google Cloud TTS — primary cheap UA voices. Wavenet first
  // (quality), then Standard (4× cheaper, slightly robotic).
  { id: 'uk-UA-Wavenet-A', provider: 'google', label: 'Wavenet A · UA',  language: 'uk-UA', gender: 'female' },
  { id: 'uk-UA-Wavenet-B', provider: 'google', label: 'Wavenet B · UA',  language: 'uk-UA', gender: 'male' },
  { id: 'uk-UA-Wavenet-C', provider: 'google', label: 'Wavenet C · UA',  language: 'uk-UA', gender: 'female' },
  { id: 'uk-UA-Wavenet-D', provider: 'google', label: 'Wavenet D · UA',  language: 'uk-UA', gender: 'male' },
  { id: 'uk-UA-Standard-A', provider: 'google', label: 'Standard A · UA (cheap)', language: 'uk-UA', gender: 'female' },
  { id: 'uk-UA-Standard-B', provider: 'google', label: 'Standard B · UA (cheap)', language: 'uk-UA', gender: 'male' },

  // Gemini TTS — multilingual generative voices (mythological names).
  // Curated set: neutral / warm / informative; skipping the loud ones.
  { id: 'Aoede',  provider: 'gemini', label: 'Aoede (warm)',         language: 'multi', gender: 'female' },
  { id: 'Kore',   provider: 'gemini', label: 'Kore (neutral)',       language: 'multi', gender: 'female' },
  { id: 'Charon', provider: 'gemini', label: 'Charon (informative)', language: 'multi', gender: 'male' },
  { id: 'Puck',   provider: 'gemini', label: 'Puck (playful)',       language: 'multi', gender: 'neutral' },
  { id: 'Fenrir', provider: 'gemini', label: 'Fenrir (grounded)',    language: 'multi', gender: 'male' },

  // ElevenLabs — premium multilingual (eleven_multilingual_v2).
  { id: 'EXAVITQu4vr4xnSDxMaL', provider: 'elevenlabs', label: 'Sarah · multilingual',    language: 'multi', gender: 'female' },
  { id: 'pNInz6obpgDQGcFmaJgB', provider: 'elevenlabs', label: 'Adam · multilingual',     language: 'multi', gender: 'male' },
  { id: 'XB0fDUnXU5powFXDhCwa', provider: 'elevenlabs', label: 'Charlotte · multilingual', language: 'multi', gender: 'female' },

  // OpenAI TTS — English-centric. Cheap, fast, noticeable accent on UA.
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
