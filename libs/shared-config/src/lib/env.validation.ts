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
  GEMINI_TTS_MODEL: z.string().default('gemini-2.5-flash-tts'),

  GOOGLE_TTS_API_KEY: z.string().optional(),
  GOOGLE_TTS_VOICE: z.string().default('uk-UA-Wavenet-A'),
  GOOGLE_TTS_LANGUAGE_CODE: z.string().default('uk-UA'),

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

  FREE_SECONDS_PER_MONTH: z.coerce.number().int().positive().default(300),
  PAID_PRICE_PER_SECOND_CENTS: z.coerce.number().int().positive().default(1),
  MAX_CALL_DURATION_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_CONCURRENT_CALLS_PER_USER: z.coerce.number().int().positive().default(1),

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
