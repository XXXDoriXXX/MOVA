// Provide deterministic dummy env BEFORE specs import modules that transitively
// pull in @mova-back/shared-config, whose module validates env at load time and
// throws on missing/invalid vars (otherwise agent-call.handler.spec — the only
// unit spec importing the handler -> shared-config — fails to even load).
//
// We force (=) rather than fill (??=): Nx loads the repo .env, which in dev can
// carry empty/placeholder values (e.g. ADMIN_PASSWORD_HASH=) that fail the
// schema. Unit specs run fully mocked, so overriding with valid dummies is
// correct and keeps the suite green regardless of the local .env.
process.env.NODE_ENV = 'test';
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'test-livekit-key';
process.env.LIVEKIT_API_SECRET = 'test-livekit-secret';
process.env.DEEPGRAM_API_KEY = 'test-deepgram-key';
// Any valid-format bcrypt hash satisfies the schema's /^\$2[abxy]\$\d{2}\$/ check.
process.env.ADMIN_PASSWORD_HASH =
  '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/mova_test';
process.env.REDIS_URL = 'redis://localhost:6379';
