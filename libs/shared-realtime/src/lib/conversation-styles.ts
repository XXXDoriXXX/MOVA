/**
 * Conversation-style presets — the system-defined "voices" the user can pick
 * before or during a call. Three built-ins plus user-defined custom styles
 * (stored in `conversation_styles` table; see api-gateway).
 *
 * Wire format — opaque string identifiers:
 *   - Built-in: `builtin:<key>` where key ∈ { official, friendly, personal }
 *   - Custom:   `custom:<uuid>`
 *
 * Why opaque strings over a discriminated union: simplifies WS protocol,
 * Redis call-control payloads, and DB columns (`templates.defaultStyleId`,
 * `users.preferredStyleId`) — one string column instead of a tagged shape.
 * Type-narrowing happens in StyleResolverService.
 */

export const BUILTIN_STYLE_KEYS = ['official', 'friendly', 'personal'] as const;
export type BuiltinStyleKey = (typeof BUILTIN_STYLE_KEYS)[number];

export const BUILTIN_STYLE_IDS = {
  OFFICIAL: 'builtin:official',
  FRIENDLY: 'builtin:friendly',
  /**
   * "PERSONAL" is not a static instruction — it's resolved at runtime from
   * the user's learned UserStyleProfile (see agent-worker StyleResolverService).
   * Falls back to FRIENDLY when the user is in cold-start (< warmup samples).
   */
  PERSONAL: 'builtin:personal',
} as const;

export type BuiltinStyleId = (typeof BUILTIN_STYLE_IDS)[keyof typeof BUILTIN_STYLE_IDS];

export interface BuiltinStylePreset {
  id: BuiltinStyleId;
  key: BuiltinStyleKey;
  /** Display name (Ukrainian, matches default UI language). */
  name: string;
  /** Short blurb shown under the chip in the picker. */
  description: string;
  /**
   * The prompt block injected into SuggestionsService.buildMessages. Null
   * for PERSONAL — that one is dynamically rendered from the user's profile
   * by StyleResolverService; the resolver checks for null and substitutes.
   */
  instructions: string | null;
}

/**
 * Canonical preset definitions. Treat as immutable at runtime — never mutate.
 * Adding a new preset requires:
 *   1. Append to this map.
 *   2. Extend BUILTIN_STYLE_KEYS.
 *   3. Migration: the existing `templates.defaultStyleId` is a free-form string
 *      column so no DB change is needed.
 */
export const BUILTIN_STYLE_PRESETS: Record<BuiltinStyleKey, BuiltinStylePreset> = {
  official: {
    id: BUILTIN_STYLE_IDS.OFFICIAL,
    key: 'official',
    name: 'Офіційний',
    description: 'Formal speech, no slang. Use for institutions, banks, official calls.',
    instructions: [
      '--- Conversation style: OFFICIAL ---',
      'Use FORMAL register only. No slang, no contractions, no regional dialect.',
      'Prefer full grammatical forms over colloquial shortenings.',
      'Address the interlocutor with polite formal pronouns (Ukrainian "Ви",',
      'English equivalent of "you sir/madam" register).',
      'Sentences should be complete and unambiguous — this is for business,',
      'government, medical, or bureaucratic conversations where precision matters.',
      'AVOID: emoji, exclamation marks for emphasis, casual interjections.',
    ].join('\n'),
  },
  friendly: {
    id: BUILTIN_STYLE_IDS.FRIENDLY,
    key: 'friendly',
    name: 'Дружній',
    description: 'Casual but polite tone for everyday calls with acquaintances.',
    instructions: [
      '--- Conversation style: FRIENDLY ---',
      'Casual but polite tone. Match the register of a friendly chat with a',
      'colleague or acquaintance — neither overly formal nor heavily slangy.',
      'Light natural shortenings are fine; avoid heavy regional dialect.',
      'Be warm and direct. Short sentences welcome.',
      'AVOID: bureaucratic phrasing, stiff formal pronouns when not required.',
    ].join('\n'),
  },
  personal: {
    id: BUILTIN_STYLE_IDS.PERSONAL,
    key: 'personal',
    name: 'Особистий',
    description: "Mimics your own writing style — improves as you type more.",
    instructions: null, // dynamic — see StyleResolverService
  },
};

/**
 * Lightweight shape validators — used at WS handshake / DB read boundaries to
 * decide which branch of the resolver to take. Keep them regex-only so they
 * remain cheap to call on the hot path.
 */
const BUILTIN_ID_RE = /^builtin:(official|friendly|personal)$/;
const CUSTOM_ID_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBuiltinStyleId(id: string): id is BuiltinStyleId {
  return BUILTIN_ID_RE.test(id);
}

export function isCustomStyleId(id: string): boolean {
  return CUSTOM_ID_RE.test(id);
}

/** True if the given string is a syntactically valid style identifier. */
export function isValidStyleId(id: string): boolean {
  return isBuiltinStyleId(id) || isCustomStyleId(id);
}

/** Build `custom:<uuid>` from a raw UUID. */
export function customStyleId(uuid: string): string {
  return `custom:${uuid}`;
}

/** Extract the UUID from a `custom:<uuid>` id; null when shape doesn't match. */
export function parseCustomStyleId(id: string): string | null {
  if (!isCustomStyleId(id)) return null;
  return id.slice('custom:'.length);
}

/** Extract the key from a `builtin:<key>` id; null when not a builtin id. */
export function parseBuiltinStyleKey(id: string): BuiltinStyleKey | null {
  const match = BUILTIN_ID_RE.exec(id);
  return match ? (match[1] as BuiltinStyleKey) : null;
}

/**
 * Maximum length of a custom style's `instructions` field — bounds prompt
 * budget. ~2KB is plenty for "speak in formal Lviv dialect, prefer X over Y"
 * style guidance without bloating every LLM call.
 */
export const CUSTOM_STYLE_INSTRUCTIONS_MAX = 2_000;

/** Display-name cap for custom styles. Fits on one line in the mobile picker. */
export const CUSTOM_STYLE_NAME_MAX = 60;

/**
 * Default style when nothing else has been chosen. PERSONAL means "use
 * what the user typically writes if we have a profile, otherwise behave
 * like FRIENDLY". Safest behaviour out of the box.
 */
export const DEFAULT_STYLE_ID: BuiltinStyleId = BUILTIN_STYLE_IDS.PERSONAL;
