import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@mova-back/shared-config';

import { EMAIL_SENDER, type EmailMessage, type EmailSender } from './email-sender';

// Logs the email instead of sending it — the default when no provider key is
// set, so verification works in dev/CI without an external account (read the
// link straight from `heroku logs`).
@Injectable()
class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('EmailSender');
  async send(message: EmailMessage): Promise<void> {
    this.logger.log({
      msg: 'email.logOnly',
      to: message.to,
      subject: message.subject,
      // The plain-text body carries the verification link verbatim.
      body: message.text,
    });
  }
}

// Sends via Resend's HTTP API when RESEND_API_KEY is configured.
@Injectable()
class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger('EmailSender');
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!res.ok) {
      this.logger.warn({
        msg: 'email.resend.httpError',
        status: res.status,
        body: await res.text().catch(() => ''),
      });
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): EmailSender => {
        const apiKey = config.get<string>('RESEND_API_KEY', {
          infer: true,
        } as never);
        const from =
          config.get<string>('EMAIL_FROM', { infer: true } as never) ??
          'Mova <onboarding@resend.dev>';
        return apiKey
          ? new ResendEmailSender(apiKey, from)
          : new LogEmailSender();
      },
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
