import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EMAIL_SENDER, type EmailSender } from './email-sender';
import { EmailModule } from './email.module';

const message = {
  to: 'user@example.com', subject: 'Verify email',
  text: 'https://mova.example/confirm?token=private-token', html: 'Verify email',
};

async function sender(config: Record<string, string>) {
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({
      isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => config],
    }), EmailModule],
  }).compile();
  return { module, send: module.get<EmailSender>(EMAIL_SENDER) };
}

describe('email delivery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not leak verification tokens when production email is not configured', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { module, send } = await sender({ NODE_ENV: 'production' });
    log.mockClear();
    try {
      await expect(send.send(message)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(log).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });

  it('reports provider failure instead of claiming the verification email was sent', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('provider error', { status: 503 }));
    const { module, send } = await sender({ NODE_ENV: 'production', RESEND_API_KEY: 'test-key' });
    try {
      await expect(send.send(message)).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally { await module.close(); }
  });
});
