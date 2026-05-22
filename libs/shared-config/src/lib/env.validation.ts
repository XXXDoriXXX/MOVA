import { z } from 'zod';

/**
 * Environment schema for all Mova services.
 *
 * Each variable has either:
 *   - a sane default for local dev (`.default()`), or
 *   - is required (no default + .min(1) / .url()).
 *
 * Optional-in-prod variables (Sentry, Lakera, Anthropic, Groq, ElevenLabs) DEGRADE
 * gracefully: the consumer code checks the presence and disables the corresponding
 * feature when missing. This makes local-dev frictionless and lets us roll out
 * vendor keys incrementally in production.
 *
 * IMPORTANT: never read `process.env` directly elsewhere. Always inject
 * `ConfigService<AppEnv, true>` from `@nestjs/config`.
 */
/**
 * `.env`-friendly boolean parser. `z.coerce.boolean()` is a footgun for env
 * vars: it does `Boolean(value)` which makes the literal string `"false"`
 * (any non-empty string) coerce to TRUE. With this helper, only the canonical
 * strings "true"/"false" (case-insensitive) AND real booleans are accepted.
 *
 * Output is always a JavaScript boolean.
 */
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
  // ── App ────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SERVICE_NAME: z.string().default('mova-service'),
  APP_VERSION: z.string().default('0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── Database (Postgres) ────────────────────────────
  DATABASE_URL: z
    .string()
    .url({ message: 'DATABASE_URL must be a valid postgres:// URL' })
    .default('postgresql://postgres:postgres@localhost:5432/mova_dev'),
  DATABASE_SSL: envBool(false),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(20),

  // ── Redis ──────────────────────────────────────────
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().default(''),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),

  // ── Auth (JWT) ─────────────────────────────────────
  // SECURITY: JWT_SECRET has a dev-only default, but is REQUIRED in production
  // (refine below). Without this, a deploy with a forgotten env var would sign
  // tokens with the public default and any reader of this file could forge them.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 chars (HS256). Replace with RS256 in prod.')
    .default('dev-only-secret-please-replace-in-production-min-32-chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // ── Admin panel ───────────────────────────────────
  // SECURITY: simple bearer-token auth for the admin UI. Set this in
  // production. When empty (dev), the admin endpoints respond with 503
  // and the UI shows a clear "set ADMIN_PASSWORD" hint. Authentication
  // is intentionally bare-bones — for a single dev/operator tool,
  // password-only is fine; for multi-admin teams, swap to JWT + DB
  // role flags later.
  ADMIN_PASSWORD: z.string().min(8).optional(),

  // ── LiveKit (SIP + WebRTC) ─────────────────────────
  LIVEKIT_URL: z
    .string()
    .url({ message: 'LIVEKIT_URL must be a wss:// or https:// URL' }),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  SIP_TRUNK_ID: z.string().optional(),

  // ── AI providers ───────────────────────────────────
  // OpenAI is optional now that the live-call agent supports Gemini /
  // Anthropic / Groq via the LiveKit Inference Gateway (see
  // apps/agent-worker/.../llm.factory.ts). Set `LLM_PROVIDER=gemini` and the
  // OpenAI key can be left blank. Required only if you actually pick OpenAI
  // for LLM or TTS.
  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(), // Fallback LLM
  GROQ_API_KEY: z.string().optional(), // Fast LLM for suggestions
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(), // Gemini LLM

  // ── LLM safety (Lakera Guard, Phase 2/4) ───────────
  LAKERA_API_KEY: z.string().optional(),
  LAKERA_API_URL: z.string().url().default('https://api.lakera.ai/v2/guard'),
  LAKERA_FAIL_OPEN: envBool(true),
  LAKERA_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  // ── Admin-managed settings overlay (encrypted in app_setting table) ──
  // Mandatory for the admin panel's "Keys" page to function. ≥16 chars so
  // SecretCrypto can fold it into an AES-256 key without padding shenanigans.
  // Generate once with `openssl rand -base64 32` and paste into .env.
  SETTINGS_ENCRYPTION_KEY: z.string().min(16).optional(),

  // ── Gemini TTS (cheap multilingual fallback) ────────
  // Voice and model used when TTS_PROVIDER=gemini OR a template/per-call
  // override selects gemini. API key is shared with the Gemini LLM
  // provider (GEMINI_API_KEY) — no separate secret to manage.
  GEMINI_TTS_VOICE: z.string().default('Kore'),
  GEMINI_TTS_MODEL: z.string().default('gemini-2.5-flash-tts'),

  // ── Error tracking (Sentry) ────────────────────────
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // ── Password breach check (HaveIBeenPwned) ─────────
  HIBP_ENABLED: envBool(true),
  HIBP_API_URL: z.string().url().default('https://api.pwnedpasswords.com'),
  HIBP_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  // ── Rate limiting ──────────────────────────────────
  RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60), // seconds
  RATE_LIMIT_DEFAULT: z.coerce.number().int().positive().default(100), // req/window

  // ── Billing ────────────────────────────────────────
  FREE_SECONDS_PER_MONTH: z.coerce.number().int().positive().default(300),
  PAID_PRICE_PER_SECOND_CENTS: z.coerce.number().int().positive().default(1),
  MAX_CALL_DURATION_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_CONCURRENT_CALLS_PER_USER: z.coerce.number().int().positive().default(1),

  // ── Internal service URLs ──────────────────────────
  AGENT_SERVICE_URL: z.string().url().optional(),
  REALTIME_PUBLIC_URL: z.string().url().optional(),
})
  // Cross-field invariants — caught at startup, prevent footguns.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.JWT_SECRET === 'dev-only-secret-please-replace-in-production-min-32-chars') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message:
            'JWT_SECRET must be set to a strong production value when NODE_ENV=production',
        });
      }
      if (!env.SENTRY_DSN) {
        // Warn, don't fail — we still allow Sentry-less deploys, but make it explicit.
        // No-op here; observability layer will log a warning at bootstrap.
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Legacy alias — kept for backward compat with existing imports.
 * @deprecated use `AppEnv` instead
 */
export type EnvConfig = AppEnv;

/**
 * Validate raw env (process.env) at app bootstrap.
 * Throws a structured error listing every invalid var — fail-fast.
 *
 * Used as `validate: validateEnv` in NestJS ConfigModule.forRoot().
 */
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

/**
 * @deprecated use `validateEnv` instead. Kept for back-compat with old imports.
 */
export const validate = validateEnv;
