jest.mock('@mova-back/shared-config', () => ({}));

import { type INestApplication, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';

import { AuthService } from '../auth/auth.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditLogService } from './audit-log.service';
import { ProviderProbeService } from './settings/provider-probe.service';
import { SettingsService } from './settings/settings.service';

const body = { email: 'tester@example.com', password: 'Sup3rStr0ngPass!', name: 'Tester', username: 'tester' };

describe('admin beta user HTTP access', () => {
  let app: INestApplication;
  let base: string;
  const auth = { createBetaTester: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        AdminAccessGuard,
        { provide: JwtService, useValue: { verifyAsync: jest.fn(async (token) => ({
          sub: 'actor', email: 'actor@example.com', role: token === 'admin-token' ? 'admin' : 'user',
        })) } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AuthService, useValue: auth },
        ...[AdminService, AuditLogService, SettingsService, ProviderProbeService, TelemetryService]
          .map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => { await app.close(); });
  beforeEach(() => { auth.createBetaTester.mockReset(); });

  async function provision(token?: string, input: unknown = body) {
    return fetch(`${base}/admin/beta-users`, {
      method: 'POST', headers: {
        'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      }, body: JSON.stringify(input),
    });
  }

  it('rejects unauthenticated callers before provisioning', async () => {
    expect((await provision()).status).toBe(401);
    expect(auth.createBetaTester).not.toHaveBeenCalled();
  });

  it('rejects a normal user before provisioning', async () => {
    expect((await provision('user-token')).status).toBe(403);
    expect(auth.createBetaTester).not.toHaveBeenCalled();
  });

  it('accepts admin access, validates registration fields and never forwards a requested admin role', async () => {
    auth.createBetaTester.mockResolvedValue({ id: 'tester', role: 'user', emailVerified: true });
    const response = await provision('admin-token', { ...body, role: 'admin' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'tester', role: 'user', emailVerified: true });
    expect(auth.createBetaTester).toHaveBeenCalledWith(body);
  });

  it('rejects invalid registration fields', async () => {
    expect((await provision('admin-token', { ...body, password: 'short' })).status).toBe(400);
    expect(auth.createBetaTester).not.toHaveBeenCalled();
  });

  it('returns disabled beta access without creating a profile', async () => {
    auth.createBetaTester.mockRejectedValue(new NotFoundException());
    expect((await provision('admin-token')).status).toBe(404);
  });
});
