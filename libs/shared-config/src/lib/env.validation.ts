import { z } from 'zod';

export const envSchema = z.object({
  // Infrastructure
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default('my-secure-password'),

  // LiveKit
  LIVEKIT_URL: z.string().url({ message: "LIVEKIT_URL must be a valid URL" }),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  // OpenAI / Deepgram
  OPENAI_API_KEY: z.string().min(1),
  DEEPGRAM_API_KEY: z.string().min(1),

  // App Specific
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validate(config: Record<string, unknown>) {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    console.error('[FATAL]: Invalid Configuration', result.error.format());
    process.exit(1);
  }
  return result.data;
}
