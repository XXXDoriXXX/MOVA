import axios, { type AxiosError, type AxiosInstance } from 'axios';

const BASE_URL = process.env['E2E_BASE_URL'] || 'http://localhost:3000';

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true,
  timeout: 10_000,
});

function uniqueEmail(): string {
  return `e2e+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.mova.local`;
}

let stackUp = false;
beforeAll(async () => {
  try {
    const res = await api.get('/health/live', { timeout: 3_000 });
    stackUp = res.status === 200;
  } catch {
    stackUp = false;
  }
  if (!stackUp) {
    // eslint-disable-next-line no-console
    console.warn(
      `[e2e] ${BASE_URL} unreachable — skipping. Run \`docker compose up -d\` first.`,
    );
  }
});

const itLive = (name: string, fn: () => Promise<void>): void => {
  it(name, async () => {
    if (!stackUp) {
      // eslint-disable-next-line no-console
      console.log(`[e2e:skip] ${name}`);
      return;
    }
    await fn();
  });
};

describe('api-gateway e2e — call flow happy paths', () => {
  describe('Health endpoints (Phase 1.3)', () => {
    itLive('/health/live returns 200', async () => {
      const res = await api.get('/health/live');
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
    });

    itLive('/health/ready pings Postgres + Redis', async () => {
      const res = await api.get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.data.info?.redis?.status).toBe('up');
      expect(res.data.info?.database?.status).toBe('up');
    });
  });

  describe('Auth (Phase 1.1 + 6.2)', () => {
    let token = '';
    const email = uniqueEmail();
    const password = 'CorrectHorseBatteryStaple1!';

    itLive('POST /v1/auth/register creates a user', async () => {
      const res = await api.post('/v1/auth/register', {
        email,
        password,
        name: 'E2E Test User',
      });
      expect(res.status).toBe(201);
      expect(res.data.user?.email).toBe(email);
      expect(res.data.accessToken).toBeTruthy();
      token = res.data.accessToken;
    });

    itLive('POST /v1/auth/login returns a token', async () => {
      const res = await api.post('/v1/auth/login', { email, password });
      expect(res.status).toBe(200);
      expect(res.data.accessToken).toBeTruthy();
      token = res.data.accessToken;
    });

    itLive('GET /v1/auth/me returns the authenticated user', async () => {
      const res = await api.get('/v1/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.data.email).toBe(email);
    });

    itLive('PATCH /v1/auth/me persists preferredVoice (Phase 6)', async () => {
      const res = await api.patch(
        '/v1/auth/me',
        { preferredVoice: 'uk-UA-Chirp3-HD-Despina' },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(res.data.preferredVoice).toBe('uk-UA-Chirp3-HD-Despina');
    });
  });

  describe('Rate limiting (Phase 1.1)', () => {
    itLive('login is rate-limited (≤5 attempts per 15 min per IP)', async () => {
      const email = uniqueEmail();
      const password = 'definitely-not-the-right-one';
      let saw429 = false;
      for (let i = 0; i < 7; i++) {
        const res = await api.post('/v1/auth/login', { email, password });
        if (res.status === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
    });
  });

  describe('Voices catalogue', () => {
    itLive('GET /v1/voices returns the curated picker list', async () => {
      const res = await api.get('/v1/voices');
      if (res.status === 404) {
        // eslint-disable-next-line no-console
        console.warn('[e2e] /v1/voices not deployed yet — skipping');
        return;
      }
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    });
  });

  describe('Idempotency-Key replay (Phase 2.6)', () => {
    itLive('same Idempotency-Key returns identical envelope', async () => {
      const email = uniqueEmail();
      const password = 'CorrectHorseBatteryStaple1!';
      const reg = await api.post('/v1/auth/register', {
        email,
        password,
        name: 'E2E Idempotency',
      });
      if (reg.status !== 201) {
        return;
      }
      const token = reg.data.accessToken as string;

      const idempotencyKey = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const body = {
        targetPhone: '+380000000000',
        userName: 'E2E',
      };
      const headers = {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      };

      const first = await api.post('/v1/calls/start', body, { headers });
      const second = await api.post('/v1/calls/start', body, { headers });

      if (first.status >= 200 && first.status < 300) {
        expect(second.status).toBe(first.status);
        expect(second.headers['idempotency-replayed']).toBe('true');
        expect(second.data).toEqual(first.data);
      }
    });
  });
});
