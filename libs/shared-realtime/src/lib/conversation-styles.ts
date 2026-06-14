
export const BUILTIN_STYLE_KEYS = ['official', 'friendly', 'personal'] as const;
export type BuiltinStyleKey = (typeof BUILTIN_STYLE_KEYS)[number];

export const BUILTIN_STYLE_IDS = {
  OFFICIAL: 'builtin:official',
  FRIENDLY: 'builtin:friendly',
  PERSONAL: 'builtin:personal',
} as const;

export type BuiltinStyleId = (typeof BUILTIN_STYLE_IDS)[keyof typeof BUILTIN_STYLE_IDS];

export interface BuiltinStylePreset {
  id: BuiltinStyleId;
  key: BuiltinStyleKey;
  name: string;
  description: string;
  instructions: string | null;
}

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
    instructions: null,
  },
};

const BUILTIN_ID_RE = /^builtin:(official|friendly|personal)$/;
const CUSTOM_ID_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBuiltinStyleId(id: string): id is BuiltinStyleId {
  return BUILTIN_ID_RE.test(id);
}

export function isCustomStyleId(id: string): boolean {
  return CUSTOM_ID_RE.test(id);
}

export function isValidStyleId(id: string): boolean {
  return isBuiltinStyleId(id) || isCustomStyleId(id);
}

export function customStyleId(uuid: string): string {
  return `custom:${uuid}`;
}

export function parseCustomStyleId(id: string): string | null {
  if (!isCustomStyleId(id)) return null;
  return id.slice('custom:'.length);
}

export function parseBuiltinStyleKey(id: string): BuiltinStyleKey | null {
  const match = BUILTIN_ID_RE.exec(id);
  return match ? (match[1] as BuiltinStyleKey) : null;
}

export const CUSTOM_STYLE_INSTRUCTIONS_MAX = 2_000;

export const CUSTOM_STYLE_NAME_MAX = 60;

export const DEFAULT_STYLE_ID: BuiltinStyleId = BUILTIN_STYLE_IDS.PERSONAL;
