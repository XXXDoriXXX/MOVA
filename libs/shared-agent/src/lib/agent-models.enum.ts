/**
 * Canonical provider identifiers. Stored in:
 *   - Template.defaultLlmProvider / defaultTtsProvider
 *   - Conversation.initialLlmProvider / initialTtsProvider
 *   - Message.llmProvider / ttsProvider
 *   - ProviderIncident.providerName
 *
 * Add a value here whenever we onboard a new provider in Phase 6+. Existing
 * DB rows referencing removed providers stay readable — we never delete.
 */
export enum SttProviderEnum {
  DEEPGRAM = 'deepgram',
  /** OpenAI Whisper — fallback when Deepgram is degraded. */
  OPENAI = 'openai',
}

export enum LlmProviderEnum {
  OPENAI = 'openai',
  /** Anthropic Claude — primary fallback for OpenAI. */
  ANTHROPIC = 'anthropic',
  /** Groq llama — fast model for parallel suggestion generation (Phase 7). */
  GROQ = 'groq',
  /** Google Gemini — alternative primary LLM, strong multilingual. */
  GEMINI = 'gemini',
}

export enum TtsProviderEnum {
  ELEVENLABS = 'elevenlabs',
  OPENAI = 'openai',
  /** Google Gemini TTS — multilingual, ~$10 per 1M chars, decent UA quality.
   *  Uses the same GEMINI_API_KEY as the LLM provider. */
  GEMINI = 'gemini',
}
