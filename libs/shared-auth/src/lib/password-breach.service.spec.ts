import { HttpException } from '@nestjs/common';

import { PasswordBreachService } from './password-breach.service';

/** Build a ConfigService stub with the env values we need. */
type AnyConfig = ConstructorParameters<typeof PasswordBreachService>[0];

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): AnyConfig {
  const env: Record<string, unknown> = {
    HIBP_ENABLED: true,
    HIBP_API_URL: 'https://api.pwnedpasswords.com',
    HIBP_TIMEOUT_MS: 2000,
    ...overrides,
  };
  return {
    get: (key: string) => env[key],
  } as unknown as AnyConfig;
}

describe('PasswordBreachService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports breached for a known leaked password', async () => {
    // "password" -> SHA1 = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    // Suffix after first 5 chars = "1E4C9B93F3F0682250B6CF8331B7EE68FD8"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          '00000000000000000000000000000000000:5\n' +
            '1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345',
        ),
    }) as unknown as typeof fetch;

    const svc = new PasswordBreachService(makeConfig());
    expect(await svc.isBreached('password')).toBe(true);
  });

  it('reports safe for a non-leaked password', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('AAAAA:1\nBBBBB:2'),
    }) as unknown as typeof fetch;

    const svc = new PasswordBreachService(makeConfig());
    expect(await svc.isBreached('super-unique-passphrase-13579')).toBe(false);
  });

  it('fails open on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    const svc = new PasswordBreachService(makeConfig());
    expect(await svc.isBreached('something')).toBe(false);
  });

  it('returns false when disabled', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const svc = new PasswordBreachService(makeConfig({ HIBP_ENABLED: false }));
    expect(await svc.isBreached('password')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws structured 422 from assertNotBreached when breached', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345'),
    }) as unknown as typeof fetch;

    const svc = new PasswordBreachService(makeConfig());
    await expect(svc.assertNotBreached('password')).rejects.toThrow(HttpException);
  });
});
