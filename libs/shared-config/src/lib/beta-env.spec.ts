import { envSchema } from './env.validation';

describe('beta access configuration', () => {
  it('defaults off and only accepts explicit boolean configuration', () => {
    const env = {
      NODE_ENV: 'test',
      LIVEKIT_URL: 'wss://livekit.example.com',
      LIVEKIT_API_KEY: 'test',
      LIVEKIT_API_SECRET: 'test',
      DEEPGRAM_API_KEY: 'test',
    };
    expect(envSchema.parse(env).BETA_ACCESS_ENABLED).toBe(false);
    expect(envSchema.parse({ ...env, BETA_ACCESS_ENABLED: 'true' }).BETA_ACCESS_ENABLED).toBe(true);
    expect(envSchema.safeParse({ ...env, BETA_ACCESS_ENABLED: 'maybe' }).success).toBe(false);
  });
});
