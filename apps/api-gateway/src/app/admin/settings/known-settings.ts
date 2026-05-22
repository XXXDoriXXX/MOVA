/**
 * Whitelist of admin-editable env keys.
 *
 * Why a whitelist:
 *   1. Defense in depth — an admin (or compromised admin password) can't
 *      poke arbitrary `process.env` keys (e.g. flip NODE_ENV, DATABASE_URL).
 *   2. UX — the panel only shows keys with rich metadata (group, label,
 *      probe support), so the page reads as a checklist of services
 *      instead of a stale env-dump.
 *   3. Discovery — adding a new key here is the contract for "let admins
 *      manage this in the UI".
 *
 * Adding a new key:
 *   1. Add an entry here with `probe: 'none'` first.
 *   2. If a cheap upstream auth-check endpoint exists, add a case in
 *      ProviderProbeService and switch `probe` to `'live'`.
 */
export type ProbeKind = 'none' | 'live';

export interface KnownSetting {
  key: string;
  /** Human-readable label for the admin panel. */
  label: string;
  /** Group/section in the panel — drives the heading rows. */
  group: 'LLM' | 'STT' | 'TTS' | 'LiveKit' | 'Other';
  /** Short hint shown under the input. */
  description: string;
  /** Whether ProviderProbeService can do a real upstream auth check. */
  probe: ProbeKind;
  /** Reasonable lower bound to catch obvious typos before saving. */
  minLength: number;
}

export const KNOWN_SETTINGS: KnownSetting[] = [
  // ── LLM keys ──
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
  // ── STT ──
  {
    key: 'DEEPGRAM_API_KEY',
    label: 'Deepgram',
    group: 'STT',
    description: 'Powers nova-3 STT for the interlocutor side of every call.',
    probe: 'live',
    minLength: 20,
  },
  // ── TTS ──
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
  // ── LiveKit ──
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
