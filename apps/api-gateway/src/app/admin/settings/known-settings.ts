export type ProbeKind = 'none' | 'live';

export interface KnownSetting {
  key: string;
  label: string;
  group: 'LLM' | 'STT' | 'TTS' | 'LiveKit' | 'Other';
  description: string;
  probe: ProbeKind;
  minLength: number;
}

export const KNOWN_SETTINGS: KnownSetting[] = [
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI',
    group: 'LLM',
    description: 'sk-proj-… or sk-…  Powers GPT-4o / 4o-mini for voice + suggestions.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic (Claude)',
    group: 'LLM',
    description: 'sk-ant-…  Routed via LiveKit Inference Gateway.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    group: 'LLM',
    description: 'Google AI Studio key. Routed via LiveKit Inference Gateway.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'GROQ_API_KEY',
    label: 'Groq',
    group: 'LLM',
    description: 'gsk_…  Fast Llama / Mixtral inference for the suggestions LLM.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'DEEPGRAM_API_KEY',
    label: 'Deepgram',
    group: 'STT',
    description: 'Powers nova-3 STT for the interlocutor side of every call.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'GOOGLE_TTS_API_KEY',
    label: 'Google Cloud TTS',
    group: 'TTS',
    description:
      'Cloud Console API key (NOT AI Studio). Powers uk-UA-Wavenet voices — primary cheap UA TTS.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs',
    group: 'TTS',
    description: 'Multilingual voice synthesis (eleven_multilingual_v2). Premium fallback.',
    probe: 'live',
    minLength: 20,
  },
  {
    key: 'LIVEKIT_API_KEY',
    label: 'LiveKit API Key',
    group: 'LiveKit',
    description: 'Used by api-gateway + agent-worker for room creation and SIP dial.',
    probe: 'none',
    minLength: 8,
  },
  {
    key: 'LIVEKIT_API_SECRET',
    label: 'LiveKit API Secret',
    group: 'LiveKit',
    description: 'Pair to the API key above. Signs the AccessToken JWT.',
    probe: 'none',
    minLength: 16,
  },
  {
    key: 'SIP_TRUNK_ID',
    label: 'SIP Trunk ID',
    group: 'LiveKit',
    description: 'LiveKit SIP outbound trunk (configured on the LiveKit dashboard).',
    probe: 'none',
    minLength: 4,
  },
];

export function findKnownSetting(key: string): KnownSetting | undefined {
  return KNOWN_SETTINGS.find((s) => s.key === key);
}
