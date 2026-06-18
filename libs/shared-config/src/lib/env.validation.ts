import { z } from 'zod';

const envBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const lower = value.trim().toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false' || lower === '') return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected "true" or "false" (case-insensitive), got "${value}"`,
      });
      return z.NEVER;
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SERVICE_NAME: z.string().default('mova-service'),
  APP_VERSION: z.string().default('0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z
    .string()
    .url({ message: 'DATABASE_URL must be a valid postgres:// URL' })
    .default('postgresql://postgres:postgres@localhost:5432/mova_dev'),
  DATABASE_SSL: envBool(false),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(20),

  // Managed Redis providers (Heroku Key-Value Store, etc.) expose a single
  // connection URL instead of discrete host/port/password. When set it wins.
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().default(''),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 chars (HS256). Replace with RS256 in prod.')
    .default('dev-only-secret-please-replace-in-production-min-32-chars'),
  JWT_SECRET_PREVIOUS: z
    .string()
    .min(32, 'JWT_SECRET_PREVIOUS must be at least 32 chars (HS256).')
    .optional(),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  ADMIN_PASSWORD: z.string().min(8).optional(),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^\$2[abxy]\$\d{2}\$/, {
      message:
        'ADMIN_PASSWORD_HASH must be a bcrypt hash (starts with $2a$ / $2b$ / $2x$ / $2y$). Generate with `node -e "console.log(require(\'bcrypt\').hashSync(process.argv[1],12))" \'mypassword\'`.',
    })
    .optional(),

  LIVEKIT_URL: z
    .string()
    .url({ message: 'LIVEKIT_URL must be a wss:// or https:// URL' }),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  SIP_TRUNK_ID: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

  LAKERA_API_KEY: z.string().optional(),
  LAKERA_API_URL: z.string().url().default('https://api.lakera.ai/v2/guard'),
  LAKERA_FAIL_OPEN: envBool(true),
  LAKERA_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  SETTINGS_ENCRYPTION_KEY: z.string().min(16).optional(),

  GEMINI_TTS_VOICE: z.string().default('Kore'),
  // Gemini Developer API (generativelanguage v1beta, generateContent) TTS model.
  // Must be the `-preview-tts` id — `gemini-2.5-flash-tts` is the Vertex/Cloud
  // name and 404s here (see @livekit/agents-plugin-google beta TTS).
  GEMINI_TTS_MODEL: z.string().default('gemini-2.5-flash-preview-tts'),

  // OpenAI TTS model. `gpt-4o-mini-tts` streams (low latency) and speaks
  // Ukrainian noticeably better than the older `tts-1` default.
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  // Optional steering prompt for gpt-4o-mini-tts. Empty by default → the model
  // uses its plain, neutral conversational delivery (an over-eager prompt makes
  // it "act"/over-emote, which sounds off). Set only if you want a specific tone.
  OPENAI_TTS_INSTRUCTIONS: z.string().default(''),

  GOOGLE_TTS_API_KEY: z.string().optional(),
  GOOGLE_TTS_VOICE: z.string().default('uk-UA-Wavenet-A'),
  GOOGLE_TTS_LANGUAGE_CODE: z.string().default('uk-UA'),

  // Premium TTS for MOVA Plus subscribers (the `premiumVoices` entitlement).
  // Provider-agnostic so the upgrade target changes with an env edit, no code
  // change: 'openai' → OpenAI gpt-4o-mini-tts (STREAMS → low latency; voices
  // nova/onyx/shimmer/echo…), 'elevenlabs' → an ElevenLabs voiceId (streams),
  // 'gemini' → Gemini prebuilt name (Aoede/Charon — natural but NOT streaming,
  // higher latency), 'google' → a Google Cloud voice name. The gateway writes
  // provider+voice into the per-call agent config; the agent TtsFactory resolves
  // the matching engine. Default is OpenAI for the lowest perceived delay.
  PREMIUM_TTS_PROVIDER: z
    .enum(['gemini', 'google', 'elevenlabs', 'openai'])
    .default('openai'),
  // Gendered premium voices for the active provider. The subscriber's
  // `preferredVoiceGender` selects between them; null/unset → female. Defaults
  // are OpenAI voices: coral = warm female, onyx = deep natural male. Change
  // these together with PREMIUM_TTS_PROVIDER when switching engine.
  PREMIUM_TTS_VOICE_FEMALE: z.string().default('coral'),
  PREMIUM_TTS_VOICE_MALE: z.string().default('onyx'),

  // Silence (ms) after the interlocutor's last finalised word before the agent
  // treats the turn as complete — and only THEN generates one reply. Must be
  // longer than natural mid-sentence pauses, or a monologue gets chopped into
  // several turns and the agent keeps regenerating. Tune per call style.
  TURN_DEBOUNCE_MS: z.coerce.number().int().positive().default(1500),

  // Resilience: if the primary TTS (e.g. OpenAI) errors or stalls on the first
  // audio frame, the agent's FallbackTts transparently re-synthesises the same
  // line on this provider — so a call never goes silent. 'gemini' uses the
  // already-configured GOOGLE_GENERATIVE_AI_API_KEY. Unset/equal-to-primary
  // disables the wrapper.
  TTS_FALLBACK_PROVIDER: z
    .enum(['gemini', 'google', 'elevenlabs', 'openai'])
    .default('gemini'),

  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  HIBP_ENABLED: envBool(true),
  HIBP_API_URL: z.string().url().default('https://api.pwnedpasswords.com'),
  HIBP_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_DEFAULT: z.coerce.number().int().positive().default(100),

  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  // Firebase project id (e.g. mova-c4f51) — audience/issuer for verifying the
  // phone-auth ID token the mobile sends to /auth/phone/confirm.
  FIREBASE_PROJECT_ID: z.string().optional(),

  // Email verification. RESEND_API_KEY enables real sending; unset → emails are
  // only logged (dev/CI). PUBLIC_API_URL is the base for the confirm link.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  PUBLIC_API_URL: z.string().url().optional(),

  FREE_SECONDS_PER_MONTH: z.coerce.number().int().positive().default(300),
  // Base pay-as-you-go rate (PAID plan). PLUS overage is set lower so the
  // subscription is genuinely cheaper per extra minute than buying minutes raw.
  PAID_PRICE_PER_SECOND_CENTS: z.coerce.number().int().positive().default(2),
  MAX_CALL_DURATION_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_CONCURRENT_CALLS_PER_USER: z.coerce.number().int().positive().default(1),

  // MOVA Plus subscription tier. Price in kopiykas (19900 = 199 UAH), included
  // pool in seconds (7500 = 125 min), discounted overage rate, and a top-up
  // bonus that makes buying extra minutes cheaper while subscribed.
  PLUS_MONTHLY_PRICE_CENTS: z.coerce.number().int().positive().default(19_900),
  PLUS_INCLUDED_SECONDS: z.coerce.number().int().positive().default(7_500),
  PLUS_OVERAGE_PER_SECOND_CENTS: z.coerce.number().int().positive().default(1),
  PLUS_TOPUP_BONUS_PERCENT: z.coerce.number().int().min(0).max(100).default(20),

  // Payment provider for top-ups + subscription checkout. 'mock' credits
  // instantly (no real checkout); 'wayforpay' issues a real hosted invoice.
  // Defaults are WayForPay's PUBLIC sandbox merchant — real flow, no real money.
  PAYMENT_PROVIDER: z.enum(['mock', 'wayforpay']).default('mock'),
  WAYFORPAY_MERCHANT_ACCOUNT: z.string().default('test_merch_n1'),
  WAYFORPAY_MERCHANT_SECRET: z.string().default('flk3409refn54t54t*FNJRET'),
  WAYFORPAY_MERCHANT_DOMAIN: z.string().default('mova.app'),

  AGENT_SERVICE_URL: z.string().url().optional(),
  REALTIME_PUBLIC_URL: z.string().url().optional(),
})
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    if (env.JWT_SECRET === 'dev-only-secret-please-replace-in-production-min-32-chars') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message:
          'JWT_SECRET must be set to a strong production value when NODE_ENV=production',
      });
    }

    if (env.ADMIN_PASSWORD && !env.ADMIN_PASSWORD_HASH) {
      const weakPasswords = new Set([
        'password',
        'admin',
        'changeme',
        '12345678',
        'qwerty',
        'mova',
      ]);
      if (weakPasswords.has(env.ADMIN_PASSWORD.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_PASSWORD'],
          message:
            `ADMIN_PASSWORD is one of the weak defaults (${[...weakPasswords].join(', ')}). ` +
            `Migrate to ADMIN_PASSWORD_HASH (bcrypt) in production. ` +
            `Generate with: node -e "console.log(require('bcrypt').hashSync(process.argv[1],12))" 'mypassword'`,
        });
      }
    }

    if (env.JWT_SECRET_PREVIOUS && env.JWT_SECRET_PREVIOUS === env.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET_PREVIOUS'],
        message:
          'JWT_SECRET_PREVIOUS must differ from JWT_SECRET — setting them equal disables rotation.',
      });
    }

    if (!env.SENTRY_DSN) {
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export type EnvConfig = AppEnv;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `[shared-config] Invalid environment configuration:\n${issues}\n\n` +
        'Fix the env vars and restart. Schema: libs/shared-config/src/lib/env.validation.ts',
    );
  }
  return result.data;
}

export const validate = validateEnv;
