import { CostMetric } from '@mova-back/shared-database';

export interface DefaultCostRate {
  key: string;
  label: string;
  metric: CostMetric;
  provider: string;
  rate: string; // human value, see rateUnit
  rateUnit:
    | 'usd_per_1m_tokens'
    | 'usd_per_1m_chars'
    | 'usd_per_minute'
    | 'uah_per_minute'
    | 'uah_per_usd';
}

/**
 * Seed defaults from the providers' published price sheets (mid-2026). These
 * are OUR estimated cost per unit — the admin can override any of them. Keys are
 * `{group}:{provider}:{unit}`; the cost engine matches a message's provider to
 * `llm:{provider}:*` / `tts:{provider}:char`. STT + telephony are call-wide.
 *
 * Sources baked into the labels so a future editor knows what a number meant.
 */
export const DEFAULT_COST_RATES: DefaultCostRate[] = [
  // ── LLM (per 1M tokens) ────────────────────────────────────────────────
  // Groq Llama-3.3-70b — the primary cheap inference. Input/output priced apart.
  { key: 'llm:groq:input_token', label: 'Groq Llama-3.3-70b — вхідні токени', metric: CostMetric.LLM_INPUT_TOKEN, provider: 'groq', rate: '0.59', rateUnit: 'usd_per_1m_tokens' },
  { key: 'llm:groq:output_token', label: 'Groq Llama-3.3-70b — вихідні токени', metric: CostMetric.LLM_OUTPUT_TOKEN, provider: 'groq', rate: '0.79', rateUnit: 'usd_per_1m_tokens' },
  // OpenAI gpt-4o-mini — fallback voice/suggestions LLM.
  { key: 'llm:openai:input_token', label: 'OpenAI gpt-4o-mini — вхідні токени', metric: CostMetric.LLM_INPUT_TOKEN, provider: 'openai', rate: '0.15', rateUnit: 'usd_per_1m_tokens' },
  { key: 'llm:openai:output_token', label: 'OpenAI gpt-4o-mini — вихідні токени', metric: CostMetric.LLM_OUTPUT_TOKEN, provider: 'openai', rate: '0.60', rateUnit: 'usd_per_1m_tokens' },
  // Google Gemini 2.5 Flash — fallback.
  { key: 'llm:gemini:input_token', label: 'Gemini 2.5 Flash — вхідні токени', metric: CostMetric.LLM_INPUT_TOKEN, provider: 'gemini', rate: '0.30', rateUnit: 'usd_per_1m_tokens' },
  { key: 'llm:gemini:output_token', label: 'Gemini 2.5 Flash — вихідні токени', metric: CostMetric.LLM_OUTPUT_TOKEN, provider: 'gemini', rate: '2.50', rateUnit: 'usd_per_1m_tokens' },

  // ── TTS (per 1M characters) ────────────────────────────────────────────
  // ElevenLabs multilingual_v2 ≈ $0.000152/char (user's effective Starter rate).
  { key: 'tts:elevenlabs:char', label: 'ElevenLabs multilingual_v2 (преміум)', metric: CostMetric.TTS_CHAR, provider: 'elevenlabs', rate: '152', rateUnit: 'usd_per_1m_chars' },
  // Google Chirp3-HD ≈ $30/1M chars (HD tier) — the standard cheap voice.
  { key: 'tts:google:char', label: 'Google Chirp3-HD (стандарт)', metric: CostMetric.TTS_CHAR, provider: 'google', rate: '30', rateUnit: 'usd_per_1m_chars' },
  // OpenAI gpt-4o-mini-tts ≈ $0.60/1M chars.
  { key: 'tts:openai:char', label: 'OpenAI gpt-4o-mini-tts', metric: CostMetric.TTS_CHAR, provider: 'openai', rate: '0.60', rateUnit: 'usd_per_1m_chars' },
  // Gemini 2.5 Flash TTS — failover.
  { key: 'tts:gemini:char', label: 'Gemini 2.5 Flash TTS', metric: CostMetric.TTS_CHAR, provider: 'gemini', rate: '10', rateUnit: 'usd_per_1m_chars' },

  // ── STT (per minute of transcribed audio) ──────────────────────────────
  // Deepgram Nova ≈ $0.0043/min. "Free" tier is a one-time $200 credit, then this.
  { key: 'stt:deepgram:second', label: 'Deepgram Nova STT', metric: CostMetric.STT_SECOND, provider: 'deepgram', rate: '0.0043', rateUnit: 'usd_per_minute' },

  // ── Telephony (per minute) ─────────────────────────────────────────────
  // 6 UAH/min roaming NOW → set to ~1 once UA LiveKit servers land.
  { key: 'telephony:second', label: 'Телефонія (хвилина дзвінка)', metric: CostMetric.TELEPHONY_SECOND, provider: 'telephony', rate: '6', rateUnit: 'uah_per_minute' },

  // ── FX (UAH per 1 USD) — converts USD provider costs into hryvnia ───────
  { key: 'fx:usd_to_uah', label: 'Курс USD → UAH', metric: CostMetric.FX, provider: '', rate: '41.5', rateUnit: 'uah_per_usd' },
];
